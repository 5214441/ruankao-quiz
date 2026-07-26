#!/usr/bin/env python3
"""
六安市公共资源交易中心工程建设招标公告抓取器 V1.3.2

修复重点：
1. 不再只抓首页，优先访问“工程建设-招标公告”交易查询页。
2. 普通 requests 提取不到列表时，自动使用 Playwright 渲染动态页面。
3. 失败时保留旧项目，并把失败原因写入 meta.json。
4. 记录每个来源的 HTTP 状态、页面长度、候选链接数量，方便排查。
5. 详情页字段缺失时，使用 Playwright 渲染后再次解析招标编号、招标人和截止时间。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config.json"
PROJECTS_FILE = ROOT / "data" / "projects.json"
META_FILE = ROOT / "data" / "meta.json"

CN_TZ = timezone(timedelta(hours=8))
TIMEOUT = 40
MAX_CANDIDATES = 60

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/136.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

# 001001002 为“工程建设-招标公告”。
DEFAULT_SOURCE_URLS = [
    "https://ggzy.luan.gov.cn/jyxx/001001/jysearch.html",
    "https://ggzy.luan.gov.cn/",
]

CATEGORY_RULES = {
    "水利": ["水利", "河道", "防洪", "排涝", "水库", "灌溉", "农田", "湿地", "水环境", "供水", "闸", "泵站", "航道"],
    "公路": ["公路", "道路", "桥", "交通", "路面", "养护", "危桥", "国道", "省道", "县道", "乡道"],
    "市政": ["市政", "排水", "管网", "污水", "停车场", "城市更新", "基础设施", "环境整治", "道路提升", "照明"],
    "房建": ["房建", "厂房", "产业园", "就业中心", "教学楼", "办公楼", "仓储", "食堂", "学校", "医院", "酒店", "建筑", "车间", "维修", "改造"],
}
SERVICE_WORDS = ["勘察", "设计", "监理", "咨询", "检测", "审计", "造价", "全过程工程咨询"]
HIGH_VALUE_WORDS = ["霍邱", "高标准农田", "复垦", "水利", "河道", "防洪", "乡村振兴", "产业", "厂房", "道路", "桥", "排水"]
EXCLUDED_DEFAULT = ["竞争性谈判", "竞争性磋商", "询价", "单一来源", "中标候选人", "中标结果", "成交公告", "采购公告"]

REGION_ALIASES = {
    "市级": "市直区",
    "市直": "市直区",
    "市直区": "市直区",
    "金安": "金安区",
    "金安区": "金安区",
    "裕安": "裕安区",
    "裕安区": "裕安区",
    "叶集": "叶集区",
    "叶集区": "叶集区",
    "霍山": "霍山县",
    "霍山县": "霍山县",
    "霍邱": "霍邱县",
    "霍邱县": "霍邱县",
    "金寨": "金寨县",
    "金寨县": "金寨县",
    "舒城": "舒城县",
    "舒城县": "舒城县",
}


def now_iso() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def load_json(path: Path, default: Any):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def make_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=1.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
    )
    session = requests.Session()
    session.headers.update(HEADERS)
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


def stable_id(url: str, title: str) -> str:
    query = parse_qs(urlparse(url).query)
    infoid = query.get("infoid", [""])[0]
    if infoid:
        # 部分 infoid 带 gzgg/tpcp 等后缀，完整保留更稳定。
        return infoid
    return hashlib.sha1(f"{url}|{title}".encode("utf-8")).hexdigest()[:24]


def infer_category(text: str) -> str | None:
    scores = {cat: sum(1 for kw in kws if kw in text) for cat, kws in CATEGORY_RULES.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else None


def normalize_region(value: str) -> str:
    value = normalize(value).strip("[]【】〖〗 ")
    return REGION_ALIASES.get(value, value if value.endswith(("区", "县")) else "未知地区")


def parse_region(text: str) -> str:
    # 先寻找明确的行政区标记。
    for pattern in (
        r"〖([^〗]+)〗",
        r"【([^】]+)】",
        r"\[([^\]]+)\]",
    ):
        for value in re.findall(pattern, text):
            region = normalize_region(value)
            if region != "未知地区":
                return region

    # 再从整段文字中匹配。
    for alias, region in sorted(REGION_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if alias in text:
            return region
    return "未知地区"


def clean_title(text: str) -> str:
    text = normalize(text)
    text = re.sub(r"^\s*20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}日?\s*", "", text)
    text = re.sub(r"〖(?:市直区|市直|市级|金安区|金安|裕安区|裕安|叶集区|叶集|霍山县|霍山|霍邱县|霍邱|金寨县|金寨|舒城县|舒城)〗", "", text)
    text = re.sub(r"【(?:市直区|市直|市级|金安区|金安|裕安区|裕安|叶集区|叶集|霍山县|霍山|霍邱县|霍邱|金寨县|金寨|舒城县|舒城)】", "", text)
    text = re.sub(r"〖(?:招标公告|交易公告|项目信息|公告中|公告结束|公示中|已办结|正在办理|未开始)〗", "", text)
    text = re.sub(r"【(?:招标公告|交易公告|项目信息|公告中|公告结束|公示中|已办结|正在办理|未开始)】", "", text)
    text = text.replace("公告中", "").replace("公示中", "").strip(" -—|")
    return normalize(text)


def extract_publish_date(text: str) -> str:
    match = re.search(r"(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})", text)
    if not match:
        return datetime.now(CN_TZ).date().isoformat()
    year, month, day = map(int, match.groups())
    return f"{year:04d}-{month:02d}-{day:02d}"


def compact_datetime_text(text: str) -> str:
    """修复网页排版导致的“0 9时3 0分”等数字断开。"""
    value = normalize(text)
    previous = None
    while value != previous:
        previous = value
        value = re.sub(r"(?<=\d)\s+(?=\d)", "", value)
        value = re.sub(r"(?<=\d)\s+(?=[年月日时分秒])", "", value)
        value = re.sub(r"(?<=[年月日时分秒])\s+(?=\d)", "", value)
    return value


def parse_money(text: str):
    patterns = [
        r"(?:最高投标限价|招标控制价|项目概算|预算金额|合同估算价|项目投资|总投资)(?:金额)?[：:\s]*(?:为|约为|人民币|约)?\s*([\d,.]+)\s*万元",
        r"(?:最高投标限价|招标控制价|预算金额)(?:金额)?[：:\s]*(?:为|人民币)?\s*([\d,.]+)\s*元",
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, compact_datetime_text(text))
        if match:
            value = float(match.group(1).replace(",", ""))
            return round(value if index == 0 else value / 10000, 6)
    return None


def parse_deadline(text: str):
    contexts = []
    for pattern in (
        r"(?:开标时间与投标文件递交截止时间|投标文件递交截止时间|递交投标文件的截止时间|投标截止时间|开标时间)[^。；\n]{0,220}",
        r"(?:获取时间)[^。；\n]{0,180}",
    ):
        contexts.extend(re.findall(pattern, text))

    # 部分网页把同一句拆成多行，整页文本也作为最后兜底。
    if not contexts:
        contexts = [text]

    date_pattern = re.compile(
        r"(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?"
        r"(?:\s*[（(]?[星期一二三四五六日天]*[）)]?\s*)"
        r"(\d{1,2})\s*[时:：]\s*(\d{1,2})?\s*分?"
    )
    for chunk in contexts:
        match = date_pattern.search(compact_datetime_text(chunk))
        if not match:
            continue
        year, month, day, hour, minute = match.groups()
        minute = minute or "00"
        return (
            f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
            f"T{int(hour):02d}:{int(minute):02d}:00+08:00"
        )
    return None


def extract_field(text: str, labels: list[str], max_len: int = 120):
    """同时兼容“标签：值”和标签、值分成两行的详情页。"""
    lines = [normalize(line) for line in str(text or "").splitlines() if normalize(line)]
    ordered_labels = sorted(labels, key=len, reverse=True)

    for index, line in enumerate(lines):
        for label in ordered_labels:
            match = re.search(rf"{re.escape(label)}\s*[：:]?\s*(.*)$", line)
            if not match:
                continue
            value = normalize(match.group(1)).strip("：:；;，,。 ")
            if not value and index + 1 < len(lines):
                value = lines[index + 1].strip("：:；;，,。 ")
            # 避免把下一项的“地址”等标签误当成字段值。
            if not value or value.startswith(("地址", "项目实施主体（招标人）地址", "项目实施主体(招标人)地址")):
                continue
            value = re.split(r"(?:\s+[一二三四五六七八九十]+、|\s+\d+[、.])", value, maxsplit=1)[0]
            return normalize(value)[:max_len]
    return ""


def extract_qualification(text: str) -> str:
    keys = [
        "施工总承包", "专业承包", "建造师", "安全生产许可证", "联合体",
        "类似业绩", "项目经理", "技术负责人", "资质", "信用",
    ]
    found = []
    for line in re.split(r"[\n；。]", text):
        line = normalize(line)
        if 8 <= len(line) <= 200 and any(key in line for key in keys):
            found.append(line)
        if len(found) >= 6:
            break
    return "\n".join(dict.fromkeys(found))


def parse_detail_text(text: str) -> dict:
    return {
        "budgetWan": parse_money(text),
        "deadline": parse_deadline(text),
        "projectCode": extract_field(
            text,
            ["招标项目编号", "交易项目编号", "项目编号", "招标编号"],
        ),
        "tenderer": extract_field(
            text,
            [
                "项目实施主体（招标人）",
                "项目实施主体(招标人)",
                "招标人名称",
                "项目实施主体",
                "招标人",
            ],
        ),
        "qualification": extract_qualification(text),
        "detailText": text[:30000],
        "detailTextLength": len(text),
    }


def detail_data(session: requests.Session, url: str) -> dict:
    try:
        response = session.get(url, timeout=TIMEOUT)
        response.raise_for_status()
        response.encoding = response.apparent_encoding or "utf-8"
        soup = BeautifulSoup(response.text, "html.parser")
        return parse_detail_text(soup.get_text("\n", strip=True))
    except Exception as exc:
        print(f"[WARN] 详情普通请求失败：{url}：{exc}")
        return {}


def detail_needs_browser(details: dict) -> bool:
    # 详情页常由 JavaScript 动态加载。三个核心字段有任意一个缺失时启用浏览器兜底。
    return any(not details.get(key) for key in ("deadline", "projectCode", "tenderer"))


class DetailRenderer:
    """复用一个 Chromium 页面渲染多个详情页，避免每条公告重复启动浏览器。"""

    def __init__(self):
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.disabled_reason = ""

    def start(self) -> bool:
        if self.page:
            return True
        if self.disabled_reason:
            return False
        try:
            from playwright.sync_api import sync_playwright

            self.playwright = sync_playwright().start()
            self.browser = self.playwright.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            self.context = self.browser.new_context(
                locale="zh-CN",
                user_agent=HEADERS["User-Agent"],
                ignore_https_errors=True,
                viewport={"width": 1440, "height": 1200},
            )
            self.page = self.context.new_page()
            return True
        except Exception as exc:
            self.disabled_reason = f"{type(exc).__name__}: {exc}"
            print(f"[WARN] 详情页浏览器兜底不可用：{self.disabled_reason}")
            self.close()
            return False

    def fetch(self, url: str) -> dict:
        if not self.start():
            return {}
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
            body_text = ""
            for _ in range(8):
                self.page.wait_for_timeout(900)
                body_text = self.page.locator("body").inner_text(timeout=15000)
                if (
                    len(body_text) >= 800
                    and any(label in body_text for label in ("招标编号", "项目编号", "项目实施主体", "招标人"))
                ):
                    break
            if len(body_text) < 200:
                return {}
            return parse_detail_text(body_text)
        except Exception as exc:
            print(f"[WARN] 详情浏览器渲染失败：{url}：{type(exc).__name__}: {exc}")
            return {}

    def close(self) -> None:
        for resource in (self.page, self.context, self.browser):
            try:
                if resource:
                    resource.close()
            except Exception:
                pass
        self.page = self.context = self.browser = None
        try:
            if self.playwright:
                self.playwright.stop()
        except Exception:
            pass
        self.playwright = None


def merge_detail_data(primary: dict, rendered: dict) -> dict:
    merged = dict(primary or {})
    for key in ("budgetWan", "deadline", "projectCode", "tenderer", "qualification"):
        if rendered.get(key):
            merged[key] = rendered[key]
    if rendered.get("detailTextLength", 0) > merged.get("detailTextLength", 0):
        merged["detailText"] = rendered.get("detailText", "")
        merged["detailTextLength"] = rendered.get("detailTextLength", 0)
    return merged


def candidate_from_parts(href: str, text: str, context: str, base_url: str) -> dict | None:
    href = urljoin(base_url, href)
    if "jyxxparentDetail.html" not in href:
        return None

    combined = normalize(f"{context} {text}")
    query = parse_qs(urlparse(href).query)
    categorynum = query.get("categorynum", [""])[0]

    # 工程建设招标公告优先使用 categorynum；旧页面没有参数时再靠文字判定。
    if categorynum and categorynum != "001001002":
        return None
    if not categorynum and "招标公告" not in combined:
        return None

    title = clean_title(text)
    if len(title) < 5:
        title = clean_title(context)
    if len(title) < 5:
        return None

    return {
        "url": href,
        "title": title,
        "context": combined,
        "publishDate": extract_publish_date(combined),
        "region": parse_region(combined),
    }


def extract_candidates_from_html(html: str, base_url: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    output = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        text = normalize(anchor.get_text(" ", strip=True) or anchor.get("title", ""))
        parent = anchor.find_parent(["li", "tr", "article"]) or anchor.parent
        context = normalize(parent.get_text(" ", strip=True)) if parent else text
        item = candidate_from_parts(anchor["href"], text, context, base_url)
        if not item:
            continue
        key = item["url"]
        if key in seen:
            continue
        seen.add(key)
        output.append(item)
    return output


def requests_candidates(session: requests.Session, urls: list[str], diagnostics: list[dict]) -> list[dict]:
    all_items = []
    seen = set()
    for url in urls:
        record = {"mode": "requests", "url": url}
        try:
            response = session.get(url, timeout=TIMEOUT)
            record["httpStatus"] = response.status_code
            record["bytes"] = len(response.content)
            response.raise_for_status()
            response.encoding = response.apparent_encoding or "utf-8"
            items = extract_candidates_from_html(response.text, response.url)
            record["candidateCount"] = len(items)
            for item in items:
                if item["url"] not in seen:
                    seen.add(item["url"])
                    all_items.append(item)
        except Exception as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
        diagnostics.append(record)
        if len(all_items) >= 10:
            break
    return all_items


def playwright_candidates(urls: list[str], diagnostics: list[dict]) -> list[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        diagnostics.append({
            "mode": "playwright",
            "error": f"Playwright 不可用：{type(exc).__name__}: {exc}",
        })
        return []

    all_items = []
    seen = set()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        context = browser.new_context(
            locale="zh-CN",
            user_agent=HEADERS["User-Agent"],
            ignore_https_errors=True,
            viewport={"width": 1440, "height": 1200},
        )
        page = context.new_page()

        for url in urls:
            record = {"mode": "playwright", "url": url}
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=60000)
                record["httpStatus"] = response.status if response else None

                # 给动态接口留出加载时间，并滚动触发懒加载。
                page.wait_for_timeout(6000)
                for _ in range(3):
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(1200)

                record["title"] = page.title()
                record["bodyTextLength"] = len(page.locator("body").inner_text(timeout=10000))
                rows = page.locator("a[href*='jyxxparentDetail.html']").evaluate_all(
                    """anchors => anchors.map(a => {
                        const holder = a.closest('li,tr,article,.list-item,.ewb-list-node,.ewb-data-node')
                            || a.parentElement;
                        return {
                            href: a.href || a.getAttribute('href') || '',
                            text: (a.innerText || a.textContent || a.title || '').trim(),
                            context: holder ? (holder.innerText || holder.textContent || '').trim() : ''
                        };
                    })"""
                )
                record["rawAnchorCount"] = len(rows)
                added = 0
                for row in rows:
                    item = candidate_from_parts(
                        row.get("href", ""),
                        row.get("text", ""),
                        row.get("context", ""),
                        page.url,
                    )
                    if not item or item["url"] in seen:
                        continue
                    seen.add(item["url"])
                    all_items.append(item)
                    added += 1
                record["candidateCount"] = added
            except Exception as exc:
                record["error"] = f"{type(exc).__name__}: {exc}"
            diagnostics.append(record)
            if len(all_items) >= 10:
                break

        context.close()
        browser.close()
    return all_items


def compute_score(item: dict) -> int:
    title = item["title"]
    score = 52
    if item["region"] == "霍邱县":
        score += 18
    elif item["region"] == "市直区":
        score += 9
    if item["category"] in ("水利", "公路"):
        score += 10
    elif item["category"] in ("房建", "市政"):
        score += 7
    score += min(12, sum(3 for word in HIGH_VALUE_WORDS if word in title))
    if "二次" in title or "第二次" in title:
        score += 3
    if any(word in title for word in SERVICE_WORDS) and "EPC" not in title.upper() and "施工" not in title:
        score -= 15
    if item.get("budgetWan"):
        if 500 <= item["budgetWan"] <= 3000:
            score += 6
        elif item["budgetWan"] > 3000:
            score += 2
    return max(35, min(98, score))


def build_projects(
    session: requests.Session,
    candidates: list[dict],
    allowed_regions: set[str],
    allowed_categories: set[str],
    excluded: list[str],
) -> list[dict]:
    output = []
    seen = set()
    renderer = DetailRenderer()

    # 查询页通常按时间倒序，避免对站点造成过多请求。
    try:
        for candidate in candidates[:MAX_CANDIDATES]:
            title = candidate["title"]
            context = candidate["context"]
            if any(term in f"{title} {context}" for term in excluded):
                continue

            details = detail_data(session, candidate["url"])
            if detail_needs_browser(details):
                rendered = renderer.fetch(candidate["url"])
                details = merge_detail_data(details, rendered)
            combined_text = normalize(f"{title} {context} {details.get('detailText', '')}")
            category = infer_category(combined_text)
            if not category or category not in allowed_categories:
                continue

            region = candidate["region"]
            if region == "未知地区":
                region = parse_region(combined_text)
            if allowed_regions and region not in allowed_regions:
                continue

            item_id = stable_id(candidate["url"], title)
            if item_id in seen:
                continue
            seen.add(item_id)

            item = {
                "id": item_id,
                "title": title,
                "region": region,
                "category": category,
                "publishDate": candidate["publishDate"],
                "deadline": details.get("deadline"),
                "budgetWan": details.get("budgetWan"),
                "score": 0,
                "summary": "自动抓取的六安市公共资源交易中心工程建设招标公告。请进入原公告核对完整范围、资质、评标办法和截止时间。",
                "qualification": details.get("qualification", ""),
                "tenderer": details.get("tenderer", ""),
                "projectCode": details.get("projectCode", ""),
                "url": candidate["url"],
                "sourceName": "六安市公共资源交易中心",
                "isEpc": "EPC" in title.upper(),
                "isSecond": "二次" in title or "第二次" in title,
                "type": "工程建设公开招标",
            }
            item["score"] = compute_score(item)
            output.append(item)
            time.sleep(0.18)

    finally:
        renderer.close()

    output.sort(key=lambda item: item.get("publishDate", ""), reverse=True)
    return output


def scrape() -> tuple[list[dict], list[dict], str]:
    config = load_json(CONFIG_FILE, {})
    source_urls = config.get("sourceUrls") or DEFAULT_SOURCE_URLS
    excluded = config.get("excludedTerms", EXCLUDED_DEFAULT)
    allowed_categories = set(config.get("categories", ["房建", "市政", "公路", "水利"]))
    allowed_regions = set(config.get("regions", []))

    diagnostics: list[dict] = []
    session = make_session()

    candidates = requests_candidates(session, source_urls, diagnostics)
    used_source = "requests"

    if not candidates:
        print("[INFO] 普通请求未提取到公告，启用 Playwright 动态渲染兜底。")
        candidates = playwright_candidates(source_urls, diagnostics)
        used_source = "playwright"

    if not candidates:
        raise RuntimeError("交易查询页与浏览器渲染均未提取到工程建设招标公告链接。")

    projects = build_projects(
        session,
        candidates,
        allowed_regions,
        allowed_categories,
        excluded,
    )
    if not projects:
        raise RuntimeError(
            f"已找到 {len(candidates)} 个公告链接，但经过地区、工程类别和排除词筛选后为 0 条。"
        )
    return projects, diagnostics, used_source


def merge(old: list[dict], fresh: list[dict], keep_days: int) -> tuple[list[dict], int]:
    old_map = {item["id"]: item for item in old if item.get("id")}
    new_count = 0
    for item in fresh:
        previous = old_map.get(item["id"], {})
        if not previous:
            new_count += 1
        for key in ("budgetWan", "deadline", "qualification", "tenderer", "projectCode", "summary"):
            if not item.get(key) and previous.get(key):
                item[key] = previous[key]
        old_map[item["id"]] = item

    cutoff = (datetime.now(CN_TZ) - timedelta(days=keep_days)).date()
    merged = []
    for item in old_map.values():
        try:
            publish_date = datetime.fromisoformat(item["publishDate"]).date()
        except Exception:
            publish_date = datetime.now(CN_TZ).date()
        if publish_date >= cutoff:
            merged.append(item)

    merged.sort(key=lambda item: item.get("publishDate", ""), reverse=True)
    return merged, new_count


def main() -> int:
    config = load_json(CONFIG_FILE, {})
    old_projects = load_json(PROJECTS_FILE, [])
    old_meta = load_json(META_FILE, {})
    diagnostics: list[dict] = []

    try:
        fresh, diagnostics, used_source = scrape()
        merged, new_count = merge(old_projects, fresh, int(config.get("keepDays", 180)))
        write_json(PROJECTS_FILE, merged)
        meta = {
            "version": "1.3.2",
            "success": True,
            "updatedAt": now_iso(),
            "lastAttemptAt": now_iso(),
            "lastAttemptStatus": f"自动更新成功：抓取 {len(fresh)} 条，本次新增 {new_count} 条。",
            "sourceName": "六安市公共资源交易中心",
            "sourceUrl": config.get("sourceSearchUrl") or config.get("sourceUrl"),
            "usedSource": used_source,
            "count": len(merged),
            "newCount": new_count,
            "status": f"自动更新成功，本次新增 {new_count} 个项目",
            "updateSchedule": "每天北京时间09:17和11:17",
            "sourceDiagnostics": diagnostics[-8:],
        }
        write_json(META_FILE, meta)
        print(f"[OK] 抓取 {len(fresh)} 条，合并后 {len(merged)} 条，新增 {new_count} 条")
        return 0

    except Exception as exc:
        # 保留 projects.json，只更新 meta.json 让页面和 Actions 都能看见失败原因。
        meta = dict(old_meta)
        meta.update({
            "version": "1.3.2",
            "success": False,
            "lastAttemptAt": now_iso(),
            "lastAttemptStatus": f"自动更新失败，已保留旧数据：{exc}",
            "status": "今日自动抓取失败，页面当前显示上一次成功数据",
            "updateSchedule": "每天北京时间09:17和11:17",
            "sourceDiagnostics": diagnostics[-8:],
        })
        write_json(META_FILE, meta)
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
