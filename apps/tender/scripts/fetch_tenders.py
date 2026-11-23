#!/usr/bin/env python3
"""
六安市公共资源交易中心霍邱全类别招标公告抓取器 V2.0.0

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

try:
    from .notice_upgrade import attach_change_notices, revised_times
except ImportError:
    from notice_upgrade import attach_change_notices, revised_times
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config.json"
PROJECTS_FILE = ROOT / "data" / "projects.json"
META_FILE = ROOT / "data" / "meta.json"

CN_TZ = timezone(timedelta(hours=8))
TIMEOUT = 40
MAX_CANDIDATES = 240

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
    return best if scores[best] > 0 else "其他工程"


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
        r"(?:最高投标限价|招标控制价|预算金额|合同估算价|采购预算)(?:金额)?[：:\s]*(?:为|人民币)?\s*([\d,.]+)\s*元",
    ]
    for index, pattern in enumerate(patterns):
        match = re.search(pattern, compact_datetime_text(text))
        if match:
            value = float(match.group(1).replace(",", ""))
            return round(value if index == 0 else value / 10000, 6)
    return None


# Only extract a date and time in the context of an explicit notice label.
# Both values are Beijing time (UTC+08); do not assume they are interchangeable.
_NOTICE_DATETIME = re.compile(
    r"(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?\s*"
    r"(?:[（(]星期[一二三四五六日天][）)]\s*)?"
    r"(\d{1,2})\s*(?:时|点|[:：])\s*(\d{1,2})\s*(?:分|[:：]\d{1,2})?"
)

_SHARED_TIME_LABELS = (
    r"开标时间与投标文件递交截止时间",
    r"投标文件(?:递交|提交)截止时间[、，,\s]*(?:及|和|与)?\s*开标时间",
    r"开标时间[、，,\s]*(?:及|和|与)\s*投标文件(?:递交|提交)截止时间",
)


def _labeled_notice_datetime(text: str, patterns: tuple[str, ...]) -> str | None:
    value = compact_datetime_text(text).replace("\xa0", " ")
    # Some government sites insert whitespace/newlines within Chinese headings.
    value = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", value)
    for pattern in patterns:
        for label in re.finditer(pattern, value, re.I):
            after = value[label.end():label.end() + 160]
            # "开标时间前使用CA登录" is procedural guidance, not an opening time.
            if re.match(r"^\s*(?:前|之前|后|之后|起|开始前)(?=[^:：\d]|$)", after):
                continue
            match = _NOTICE_DATETIME.search(after)
            if not match or match.start() > 90:
                continue
            year, month, day, hour, minute = map(int, match.groups())
            try:
                return datetime(year, month, day, hour, minute).strftime("%Y-%m-%dT%H:%M:00+08:00")
            except ValueError:
                continue
    return None


def parse_deadline(text: str) -> str | None:
    """Only capture explicitly identified bid/response submission deadlines."""
    return _labeled_notice_datetime(text, (
        r"投标文件(?:递交|提交)(?:的)?截止时间",
        r"递交投标文件(?:的)?截止时间",
        r"投标截止时间",
        r"提交响应文件(?:的)?截止时间",
        r"响应文件(?:提交|递交)(?:截止)?时间",
        r"响应文件提交",
        r"开标时间与投标文件递交截止时间",
    ) + _SHARED_TIME_LABELS)


def parse_opening_time(text: str) -> str | None:
    """Opening time / response opening time; never guess it from a deadline."""
    return _labeled_notice_datetime(text, _SHARED_TIME_LABELS + (
        r"项目开标时间",
        r"开标(?:（开启）)?时间",
        r"响应文件开启(?:时间)?",
    ))


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
        "openingTime": parse_opening_time(text),
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
                "项目实施主体名称",
                "采购人名称",
                "采购人",
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
    essential_missing = any(not details.get(key) for key in ("deadline", "projectCode", "tenderer"))
    # Re-render JS-heavy pages when no opening time was found in a short static page.
    return essential_missing or (not details.get("openingTime") and details.get("detailTextLength", 0) < 2800)


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
    for key in ("budgetWan", "deadline", "openingTime", "projectCode", "tenderer", "qualification"):
        if rendered.get(key):
            merged[key] = rendered[key]
    if rendered.get("detailTextLength", 0) > merged.get("detailTextLength", 0):
        merged["detailText"] = rendered.get("detailText", "")
        merged["detailTextLength"] = rendered.get("detailTextLength", 0)
    return merged


def candidate_from_parts(href: str, text: str, context: str, base_url: str) -> dict | None:
    href = urljoin(base_url, href)
    parsed_url = urlparse(href)
    if parsed_url.scheme != "https" or parsed_url.hostname != "ggzy.luan.gov.cn":
        return None
    link_path = parsed_url.path
    is_standard = link_path.endswith("/jyxxparentDetail.html")
    # 官网不同栏目并不都采用 jyxxparentDetail.html，澄清有大量直达 .html 链接。
    direct_link = re.search(r"/jyxx/\d{6}/(\d{9})/20\d{6}/[^/]+\.html$", link_path)
    is_nonentry = "/jyxx/001008/001008001/" in link_path
    is_nonentry_change = "/jyxx/001008/001008005/" in link_path
    if not is_standard and not direct_link:
        return None

    combined = normalize(f"{context} {text}")
    query = parse_qs(parsed_url.query)
    categorynum = query.get("categorynum", [""])[0] or (direct_link.group(1) if direct_link else "")

    # 工程建设招标公告优先使用 categorynum；旧页面没有参数时再靠文字判定。
    allowed_types = {
        "001001002": "工程建设公开招标",
        "001001003": "工程建设澄清变更",
        "001002001": "政府采购",
        "001002002": "政府采购澄清变更",
        "001005001": "其他交易公告",
        "001005002": "其他交易变更",
        "001008001": "非进场发包",
        "001008005": "非进场发包变更",
    }
    if categorynum and categorynum not in allowed_types:
        return None
    if not categorynum and not (is_nonentry or is_nonentry_change) and not any(label in combined for label in ("招标公告", "采购公告", "发包公告", "变更公告", "更正公告", "澄清")):
        return None
    if any(word in combined[:100] for word in ("中标结果公告", "成交结果公告")):
        return None
    notice_type = ("非进场发包变更" if is_nonentry_change else "非进场发包" if is_nonentry
                   else allowed_types.get(categorynum, "工程建设公开招标" if "招标公告" in combined else "政府采购"))
    is_change = notice_type.endswith(("澄清变更", "交易变更", "发包变更"))

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
        "noticeType": notice_type,
        "noticeKind": "change" if is_change else "original",
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
        if len(all_items) >= MAX_CANDIDATES:
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
                rows = page.locator("a[href*='jyxxparentDetail.html'], a[href*='/jyxx/001001/'], a[href*='/jyxx/001002/'], a[href*='/jyxx/001005/'], a[href*='/jyxx/001008/']").evaluate_all(
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
            if len(all_items) >= MAX_CANDIDATES:
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
            # 先跳过已标明属于其他区县的公告，避免逐条加载无关详情导致超时。
            candidate_region = candidate.get("region", "未知地区")
            if allowed_regions and candidate_region not in ("未知地区", "", None) and candidate_region not in allowed_regions:
                continue
            title = candidate["title"]
            context = candidate["context"]
            if candidate.get("noticeKind") != "change" and any(term in f"{title} {context}" for term in excluded):
                continue

            details = detail_data(session, candidate["url"])
            if detail_needs_browser(details):
                rendered = renderer.fetch(candidate["url"])
                details = merge_detail_data(details, rendered)
            combined_text = normalize(f"{title} {context} {details.get('detailText', '')}")
            notice_type = candidate.get("noticeType", "工程建设公开招标")
            if notice_type.startswith("政府采购"):
                category = "政府采购"
            elif notice_type == "非进场发包" and "服务类" in combined_text and not any(word in title for word in ("施工", "工程", "改造", "建设")):
                category = "服务"
            else:
                category = infer_category(combined_text)
            if allowed_categories and category not in allowed_categories:
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
                "noticeKind": candidate.get("noticeKind", "original"),
                "title": title,
                "region": region,
                "category": category,
                "publishDate": candidate["publishDate"],
                "deadline": details.get("deadline"),
                "openingTime": details.get("openingTime"),
                "budgetWan": details.get("budgetWan"),
                "score": 0,
                "summary": f"自动抓取的六安市公共资源交易中心{notice_type}。请进入原公告核对完整范围、资质、评标办法和截止时间。",
                "qualification": details.get("qualification", ""),
                "tenderer": details.get("tenderer", ""),
                "projectCode": details.get("projectCode", ""),
                "url": candidate["url"],
                "sourceName": "六安市公共资源交易中心",
                "isEpc": "EPC" in title.upper(),
                "isSecond": "二次" in title or "第二次" in title,
                "type": notice_type,
            }
            if item["noticeKind"] == "change":
                item["revisedTimes"] = revised_times(
                    details.get("detailText", ""), parse_deadline, parse_opening_time
                )
                # 改动公告可能同时写有旧时间，严禁将其误判为新的开标时间。
                item["deadline"] = item["revisedTimes"].get("deadline")
                item["openingTime"] = item["revisedTimes"].get("openingTime")
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
    allowed_regions = set(config.get("fetchRegions") or config.get("regions", []))

    diagnostics: list[dict] = []
    session = make_session()

    candidates = requests_candidates(session, source_urls, diagnostics)
    used_source = "requests"

    # 动态交易查询页与官网首页互补，不能因首页已有少量结果而跳过其他栏目。
    if len(candidates) < MAX_CANDIDATES:
        try:
            rendered = playwright_candidates(source_urls, diagnostics)
            combined = {item["url"]: item for item in candidates}
            for item in rendered:
                combined.setdefault(item["url"], item)
            candidates = list(combined.values())[:MAX_CANDIDATES]
            if rendered:
                used_source = "requests+playwright"
        except Exception as exc:
            diagnostics.append({"mode": "playwright", "error": f"{type(exc).__name__}: {exc}"})
            print(f"[WARN] 浏览器候选列表抓取失败，将使用普通请求的结果：{exc}")

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
        # 县级项目不是每天都有新公告；抓到了有效候选但当天没有霍邱项目不应报失败。
        if allowed_regions == {"霍邱县"}:
            print(f"[INFO] 已提取 {len(candidates)} 条公告，但本次没有可匹配的霍邱项目。")
        else:
            raise RuntimeError(
                f"已找到 {len(candidates)} 个公告链接，但经过地区、类别和排除词筛选后为 0 条。"
            )
    return projects, diagnostics, used_source


def merge(old: list[dict], fresh: list[dict], keep_days: int) -> tuple[list[dict], int]:
    old_map = {item["id"]: item for item in old if item.get("id")}
    new_count = 0
    for item in fresh:
        previous = old_map.get(item["id"], {})
        if not previous:
            new_count += 1
        for key in ("budgetWan", "deadline", "openingTime", "openingTimeCheckedAt", "qualification", "tenderer", "projectCode", "summary", "changeNotices", "lastChangeDate", "deadlineSourceUrl", "openingTimeSourceUrl", "relatedProjectId", "relatedProjectTitle"):
            if not item.get(key) and previous.get(key):
                item[key] = previous[key]
        if item.get("noticeKind") != "change":
            # 最新澄清已经证实的时间优先于旧招标公告中的历史时间。
            for field in ("deadline", "openingTime"):
                if previous.get(field + "SourceUrl") and previous.get(field):
                    item[field] = previous[field]
                    item[field + "SourceUrl"] = previous[field + "SourceUrl"]
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

    changes_applied = attach_change_notices(merged)
    if changes_applied:
        print(f"[INFO] 已依据明确变更公告修订 {changes_applied} 个时间字段。")
    merged.sort(key=lambda item: item.get("publishDate", ""), reverse=True)
    return merged, new_count


def backfill_opening_times(projects: list[dict], limit: int = 12) -> tuple[int, int]:
    """Recheck recent Huoqiu notices; never guess unpublished opening times."""
    session = make_session()
    renderer = DetailRenderer()
    checked = 0
    resolved = 0
    today = datetime.now(CN_TZ)
    cutoff = today.date() - timedelta(days=90)
    try:
        for item in projects:
            if checked >= limit:
                break
            if item.get("region") != "霍邱县" or item.get("openingTime") or item.get("noticeKind") == "change":
                continue
            url = str(item.get("url") or "")
            if not url.startswith("https://ggzy.luan.gov.cn/"):
                continue
            try:
                date = datetime.fromisoformat(str(item.get("publishDate"))).date()
            except (ValueError, TypeError):
                continue
            if date < cutoff:
                continue
            last_checked = item.get("openingTimeCheckedAt")
            if last_checked:
                try:
                    if today - datetime.fromisoformat(last_checked) < timedelta(days=2):
                        continue
                except (ValueError, TypeError):
                    pass
            checked += 1
            try:
                parsed = detail_data(session, url)
                opening_time = parsed.get("openingTime")
                if not opening_time:
                    opening_time = renderer.fetch(url).get("openingTime")
                if opening_time:
                    item["openingTime"] = opening_time
                    resolved += 1
            except Exception as exc:
                print(f"[WARN] 回查开标时间失败：{url}：{exc}")
            item["openingTimeCheckedAt"] = now_iso()
    finally:
        renderer.close()
        session.close()
    return checked, resolved


def main() -> int:
    config = load_json(CONFIG_FILE, {})
    old_projects = load_json(PROJECTS_FILE, [])
    old_meta = load_json(META_FILE, {})
    diagnostics: list[dict] = []

    try:
        fresh, diagnostics, used_source = scrape()
        merged, new_count = merge(old_projects, fresh, int(config.get("keepDays", 180)))
        try:
            checked, resolved = backfill_opening_times(merged)
            print(f"[INFO] 旧项目开标时间回查：检查 {checked} 条，识别 {resolved} 条。")
        except Exception as exc:
            checked = resolved = 0
            print(f"[WARN] 旧项目开标时间回查异常，不影响主抓取：{exc}")
        write_json(PROJECTS_FILE, merged)
        meta = {
            "version": "2.1.0",
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
            "openingTimeBackfillChecked": checked,
            "openingTimeBackfillResolved": resolved,
        }
        write_json(META_FILE, meta)
        print(f"[OK] 抓取 {len(fresh)} 条，合并后 {len(merged)} 条，新增 {new_count} 条")
        return 0

    except Exception as exc:
        # 保留 projects.json，只更新 meta.json 让页面和 Actions 都能看见失败原因。
        meta = dict(old_meta)
        meta.update({
            "version": "2.1.0",
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
