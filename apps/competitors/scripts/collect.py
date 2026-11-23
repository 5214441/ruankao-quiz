"""六安市公共资源交易公开开评标数据采集。只保存可核对的公开事实。"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://ggzy.luan.gov.cn"
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "records.json"
SEEDS = ROOT / "data" / "seed_urls.json"
CN = timezone(timedelta(hours=8))
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; KKBidIntelligence/1.0; public-info-monitor)",
           "Accept-Language": "zh-CN,zh;q=0.9"}
# 只有正式确认的栏目进入采集，避免把其他公告视作开标价格。
TYPES = {
    "001001012": "opening",
    "001002008": "opening",
    "001009008": "opening",
    "001001004": "candidate",
    "001001005": "result",
    "001002003": "result",
    "001008002": "result",
}
LIST_URLS = [
    f"{BASE}/jyxx/001001/jysearch.html",
    f"{BASE}/jyxx/001002/jysearch.html",
    f"{BASE}/jyxx/001008/jysearch.html",
    f"{BASE}/jyxx/jysearch.html",
    BASE + "/",
]
DATE_RE = re.compile(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})")
NUMBER = re.compile(r"^-?\d[\d,]*(?:\.\d+)?$")
MONEY = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(亿元|万元|元)\b")
CODE = re.compile(r"(?:E\d{10,}(?:\d{3})?|FS\d{10,}|HXJY[A-Z0-9]{10,})", re.I)

def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()

def now():
    return datetime.now(CN).isoformat(timespec="seconds")

def jsonread(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default

def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)

def allowed_url(url):
    p = urlparse(url)
    return p.scheme == "https" and p.hostname == "ggzy.luan.gov.cn" and not p.username and not p.password

def kind_for_url(url):
    p = urlparse(url)
    m = re.search(r"/jyxx/\d{6}/(\d{9})/\d{8}/[^/]+\.html$", p.path)
    category = m.group(1) if m else parse_qs(p.query).get("categorynum", [""])[0]
    return TYPES.get(category)

def canonical(url):
    p = urlparse(url)
    if not allowed_url(url):
        return ""
    if kind_for_url(url) is None:
        return ""
    return f"{p.scheme}://{p.netloc}{p.path}" + ("?" + p.query if p.query else "")

def get_candidates(html, base):
    soup = BeautifulSoup(html, "html.parser")
    found = set()
    for a in soup.select("a[href]"):
        url = canonical(urljoin(base, a.get("href", "")))
        if url and url not in found:
            found.add(url)
            yield url

def label_value(soup, labels):
    # 官网资料通常由“项目编号 | XXX | 统一交易标识码”这种表格组成。
    labels = {clean(x).replace("：", "") for x in labels}
    for tr in soup.select("tr"):
        cells = [clean(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"], recursive=False)]
        for i in range(0, len(cells) - 1):
            if cells[i].rstrip(":：") in labels and cells[i + 1]:
                return cells[i + 1]
    text = clean(soup.get_text(" ", strip=True))
    for label in labels:
        m = re.search(re.escape(label) + r"[：:]\s*([^；;，,|]{2,75})", text)
        if m:
            return clean(m.group(1))
    return ""

def money_yuan(raw, unit=None):
    value = clean(raw).replace(",", "").replace("￥", "").replace("¥", "")
    if not value or value in {"—", "-", "未公开"}:
        return None
    if unit:
        m = NUMBER.fullmatch(value)
        if not m:
            return None
        number = float(value)
        factor = {"元": 1, "万元": 1e4, "亿元": 1e8}.get(unit)
    else:
        m = MONEY.fullmatch(value)
        if not m:
            return None
        number = float(m.group(1))
        factor = {"元": 1, "万元": 1e4, "亿元": 1e8}.get(m.group(2))
    amount = round(number * factor, 2) if factor else None
    return amount if amount is not None and amount > 0 and amount < 1e13 else None

def project_region(title, source, location):
    # 项目所在地或来源为权威字段；同一公告提及其他县不能改地区。
    for field in (location, source):
        if "霍邱" in field:
            return "霍邱县"
        for area in ("金寨县", "霍山县", "舒城县", "裕安区", "金安区", "叶集区"):
            if area in field:
                return area
    if "霍邱" in title:
        return "霍邱县"
    return "待核实"

def category(title):
    mappings = [
        ("水利", ("水利", "农田", "排灌", "河道", "防洪", "水库", "堤防")),
        ("公路", ("公路", "桥梁", "县道", "省道", "乡道", "道路养护")),
        ("市政", ("市政", "污水", "雨污", "管网", "排水", "道路", "市容")),
        ("房建", ("厂房", "建筑", "住宅", "医院", "学校", "装修", "改造", "宿舍")),
        ("服务", ("检测", "咨询", "勘察", "设计", "监理", "保安", "审计")),
    ]
    for label, words in mappings:
        if any(w in title for w in words):
            return label
    return "其他"

def parse_quotes(soup):
    """严格要求表格同时包含“投标人”和“报价”列。保留联合体为单条投标记录。"""
    quotes = []
    for table in soup.select("table"):
        rows = table.select("tr")
        header_idx = None
        for i, tr in enumerate(rows[:7]):
            cols = [clean(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"], recursive=False)]
            if any("投标人" in c or "供应商" in c for c in cols) and any("报价" in c for c in cols):
                header_idx = i
                break
        if header_idx is None:
            continue
        heads = [clean(c.get_text(" ", strip=True)) for c in rows[header_idx].find_all(["th", "td"], recursive=False)]
        name_i = next((i for i, h in enumerate(heads) if "投标人" in h or "供应商" in h), None)
        price_i = next((i for i, h in enumerate(heads) if "报价" in h), None)
        unit_i = next((i for i, h in enumerate(heads) if "单位" in h), None)
        if name_i is None or price_i is None:
            continue
        implicit_unit = "万元" if "万元" in heads[price_i] else "元" if "/元" in heads[price_i] else None
        for tr in rows[header_idx + 1:]:
            cells = [clean(c.get_text(" ", strip=True)) for c in tr.find_all(["td", "th"], recursive=False)]
            if len(cells) <= max(name_i, price_i):
                continue
            company = cells[name_i]
            if not company or company in ("无", "/", "-") or len(company) > 200:
                continue
            amount_text = cells[price_i]
            unit = cells[unit_i] if unit_i is not None and len(cells) > unit_i else implicit_unit
            amount = money_yuan(amount_text, unit)
            # “0”或非元单位/比例报价不得当作有效人民币报价。
            quotes.append({
                "bidder": company, "bidYuan": amount,
                "rawPrice": amount_text, "rawUnit": clean(unit or ""),
                "quoteStatus": "valid" if amount is not None else "unverified",
            })
        if quotes:
            break
    seen, unique = set(), []
    for q in quotes:
        key = (q["bidder"], q["rawPrice"], q["rawUnit"])
        if key not in seen:
            seen.add(key)
            unique.append(q)
    return unique

def extract_result(soup):
    # 不能靠“推荐排名第一单位”冒充最终中标人。
    name = label_value(soup, ["中标人名称", "中标单位", "中标人", "成交供应商", "成交单位", "中标供应商名称"])
    price = label_value(soup, ["中标价", "中标金额", "中标（成交）价", "成交金额", "中标价格"])
    return {"winner": name[:160], "winningYuan": money_yuan(price) if price else None}

def parse_page(html, url):
    kind = kind_for_url(url)
    if not kind:
        return None
    soup = BeautifulSoup(html, "html.parser")
    title = label_value(soup, ["标段（包）名称", "包件（标段）名称", "交易项目名称", "标段名称"])
    if not title:
        for h in soup.select("h1,h2,h3,h4"):
            value = clean(h.get_text(" ", strip=True))
            if len(value) >= 8 and not any(x in value for x in ("交易查询", "办事指南", "开评标信息", "开标记录信息")):
                title = value
                break
    if not title:
        title = clean(soup.title.get_text(" ", strip=True) if soup.title else "")
    if not title or len(title) < 6 or len(title) > 250:
        return None
    code_text = label_value(soup, ["项目编号", "交易项目编号", "招标项目编号"])
    segment = label_value(soup, ["标段（包）编号", "包件（标段）编号", "标段编号"])
    code_match = CODE.search(code_text)
    project_code = code_match.group(0).upper() if code_match else ""
    source = label_value(soup, ["信息来源"])
    location = label_value(soup, ["项目所在地"])
    region = project_region(title, source, location)
    quote_rows = parse_quotes(soup) if kind == "opening" else []
    outcome = extract_result(soup) if kind == "result" else {"winner": "", "winningYuan": None}
    # 原始页链、项目、标段、公告类型必须可追溯，不凭模糊企业名做跨项目关联。
    identity = hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]
    date_match = re.search(r"/(20\d{6})/", url)
    published = ""
    if date_match:
        value = date_match.group(1)
        published = f"{value[:4]}-{value[4:6]}-{value[6:8]}"
    record = {
        "id": identity, "kind": kind, "title": title[:220],
        "projectCode": project_code, "segmentCode": segment[:100],
        "region": region, "category": category(title),
        "publishDate": published, "url": url,
        "openingTime": label_value(soup, ["开标时间"]),
        "quotes": quote_rows,
        **outcome,
    }
    return record

def enumerate_urls(session, max_links=160):
    found = set()
    for url in LIST_URLS:
        try:
            res = session.get(url, timeout=25)
            res.raise_for_status()
            res.encoding = res.apparent_encoding or "utf-8"
            for item in get_candidates(res.text, url):
                if item not in found:
                    found.add(item)
                    yield item
                    if len(found) >= max_links:
                        return
        except requests.RequestException as exc:
            print(f"[WARN] 静态列表失败 {url}: {exc}")

def browser_urls(max_pages=4, max_links=240):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return []
    links = set()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
            page = browser.new_page(locale="zh-CN", ignore_https_errors=True)
            for url in LIST_URLS[:-1]:
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(4500)
                    for page_no in range(max_pages):
                        found = page.locator("a[href]").evaluate_all("els => els.map(e => e.href)")
                        for href in found:
                            canonical_url = canonical(href)
                            if canonical_url:
                                links.add(canonical_url)
                        if len(links) >= max_links:
                            break
                        # 仅点击真实可见且可用的下一页，防止无限循环。
                        nxt = page.locator("a:visible").filter(has_text=re.compile("下一页|下页")).first
                        if nxt.count() == 0 or not nxt.is_enabled():
                            break
                        before = page.url + str(len(found))
                        nxt.click(timeout=3000)
                        page.wait_for_timeout(3000)
                        if before == page.url + str(len(page.locator("a[href]").all())):
                            break
                except Exception as exc:
                    print(f"[WARN] 浏览器列表失败 {url}: {type(exc).__name__}: {exc}")
            browser.close()
    except Exception as exc:
        print(f"[WARN] 浏览器不可用: {type(exc).__name__}: {exc}")
    return sorted(links)[:max_links]

class DetailBrowser:
    """只有静态请求未得到必要字段时才启用同一个 Chromium 浏览器。"""

    def __init__(self):
        self.pw = None
        self.browser = None
        self.page = None
        self.disabled = False

    def fetch(self, url):
        if self.disabled or not canonical(url):
            return None
        try:
            if self.page is None:
                from playwright.sync_api import sync_playwright
                self.pw = sync_playwright().start()
                self.browser = self.pw.chromium.launch(headless=True, args=["--no-sandbox"])
                self.page = self.browser.new_page(locale="zh-CN", ignore_https_errors=True)
            self.page.goto(url, wait_until="domcontentloaded", timeout=45000)
            for _ in range(5):
                self.page.wait_for_timeout(1400)
                result = parse_page(self.page.content(), url)
                if result and (result["kind"] != "opening" or result.get("quotes")):
                    return result
            return parse_page(self.page.content(), url)
        except Exception as exc:
            print(f"[WARN] 详情渲染失败 {url}: {type(exc).__name__}: {exc}")
            self.close()
            self.disabled = True
            return None

    def close(self):
        try:
            if self.page: self.page.close()
            if self.browser: self.browser.close()
            if self.pw: self.pw.stop()
        except Exception:
            pass
        self.page = self.browser = self.pw = None


def normalized_bidder(value):
    return re.sub(r"\s+", "", str(value or "")).replace("（", "(").replace("）", ")")

def combine(records):
    # 始终保留每个来源页面，归并时绝不丢失不同标段。
    # 统计归并不得修改原始输入，确保重复计算和回归测试幂等。
    records = sorted((dict(r) for r in records), key=lambda x: (x.get("publishDate", ""), x["id"]), reverse=True)
    identities = defaultdict(list)
    for r in records:
        if r.get("projectCode") and r.get("segmentCode"):
            identities[(r["projectCode"], r["segmentCode"])].append(r)
    # 仅在明确项目编号+标段编号一致时连接跨阶段记录。
    for group in identities.values():
        opening = next((r for r in group if r["kind"] == "opening"), None)
        result = next((r for r in group if r["kind"] == "result"), None)
        if opening and result:
            opening["winner"] = result.get("winner") or ""
            opening["winningYuan"] = result.get("winningYuan")
            opening["resultSourceUrl"] = result["url"]
    company_map = {}
    bids = []
    for r in records:
        if r["kind"] == "opening":
            for q in r.get("quotes", []):
                name = normalized_bidder(q["bidder"])
                if not name:
                    continue
                entry = company_map.setdefault(name, {"name": q["bidder"], "appearances": 0, "wins": 0,
                                                     "projects": [], "validPriceCount": 0})
                entry["appearances"] += 1
                if q.get("bidYuan") is not None:
                    entry["validPriceCount"] += 1
                entry["projects"].append(r["id"])
                if r.get("winner") and name == normalized_bidder(r["winner"]):
                    entry["wins"] += 1
                bids.append({
                    "id": r["id"] + ":" + hashlib.sha1(name.encode()).hexdigest()[:12],
                    "projectId": r["id"], "bidder": q["bidder"], "bidYuan": q.get("bidYuan"),
                    "quoteStatus": q.get("quoteStatus"), "rawPrice": q.get("rawPrice"),
                    "unit": q.get("rawUnit"), "date": r.get("publishDate"),
                    "region": r.get("region"), "category": r.get("category"),
                    "project": r.get("title"), "sourceUrl": r["url"],
                })
    companies = sorted(company_map.values(), key=lambda x: (-x["appearances"], x["name"]))
    for c in companies:
        c["projects"] = sorted(set(c["projects"]))
    return {"projects": records, "bids": bids, "companies": companies}

def run(no_browser=False, max_new=200):
    old = jsonread(DATA, {"projects": []})
    seen = {r["url"]: r for r in old.get("projects", []) if r.get("url")}
    seeds = jsonread(SEEDS, [])
    session = requests.Session()
    session.headers.update(HEADERS)
    urls = list(dict.fromkeys([*seeds, *enumerate_urls(session), *([] if no_browser else browser_urls())]))
    new_count, errors = 0, 0
    renderer = DetailBrowser() if not no_browser else None
    for url in urls:
        if not canonical(url):
            continue
        if url in seen and seen[url].get("quotes"):
            # 有完整报价记录的旧公告不必反复请求。
            continue
        if new_count >= max_new:
            break
        try:
            response = session.get(url, timeout=30)
            response.raise_for_status()
            response.encoding = response.apparent_encoding or "utf-8"
            record = parse_page(response.text, url)
            if renderer and (
                not record
                or (record["kind"] == "opening" and not record.get("quotes"))
                or (record["kind"] == "result" and not record.get("winner"))
            ):
                rendered = renderer.fetch(url)
                if rendered and (not record or len(rendered.get("quotes", [])) > len(record.get("quotes", []))
                                 or (rendered.get("winner") and not record.get("winner"))):
                    record = rendered
            if not record:
                continue
            if record["region"] != "霍邱县":
                # 非霍邱记录不纳入正式主库，减少无效数据。
                continue
            if record["kind"] == "opening" and not record["quotes"]:
                # 不制造无报价的“投标人统计”，保留记录以示完整性。
                pass
            seen[url] = record
            new_count += 1
        except requests.RequestException as exc:
            errors += 1
            print(f"[WARN] 详情采集失败 {url}: {type(exc).__name__}: {exc}")
        time.sleep(0.1)
    if renderer:
        renderer.close()
    if not seen:
        raise RuntimeError("没有可用的官方数据，保留已有文件，停止发布空数据库")
    bundle = combine(list(seen.values()))
    previous = jsonread(DATA, {})
    total = len(bundle["projects"])
    bundle["meta"] = {
        "version": "1.0.0", "updatedAt": now(), "source": BASE,
        "records": total, "openingRecords": sum(r["kind"] == "opening" for r in bundle["projects"]),
        "quoteRows": len(bundle["bids"]), "companies": len(bundle["companies"]),
        "newOrUpdated": new_count, "fetchErrors": errors,
        "status": "已更新" if new_count else ("沿用已有记录" if previous.get("projects") else "数据暂未增加"),
        "coverage": "霍邱县；仅已公开且成功采集的官方页面，不能代表全部投标活动",
    }
    atomic_write(DATA, bundle)
    print(f"[OK] 官方记录 {total}，报价行 {len(bundle['bids'])}，企业 {len(bundle['companies'])}，本轮新增或重取 {new_count}")
    return bundle

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-browser", action="store_true", help="不用 Chromium，便于离线回归或诊断")
    parser.add_argument("--max-new", type=int, default=200)
    args = parser.parse_args()
    run(args.no_browser, max(1, args.max_new))
