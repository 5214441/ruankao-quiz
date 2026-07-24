#!/usr/bin/env python3
"""
从六安市公共资源交易中心公开首页提取工程建设招标公告。
规则：
1. 只保留“招标公告”。
2. 排除谈判、磋商、询价、中标、成交、采购公告。
3. 只保留房建、市政、公路、水利。
4. 自动尝试识别预算、截止时间、招标人、项目编号和资质关键词。
5. 抓取失败时保留旧数据，不清空正式题库/项目库。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config.json"
PROJECTS_FILE = ROOT / "data" / "projects.json"
META_FILE = ROOT / "data" / "meta.json"

CN_TZ = timezone(timedelta(hours=8))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; LuanTenderDashboard/1.0; public-information-monitor)",
    "Accept-Language": "zh-CN,zh;q=0.9",
}
TIMEOUT = 35

CATEGORY_RULES = {
    "水利": ["水利", "河道", "防洪", "排涝", "水库", "灌溉", "农田", "湿地", "水环境", "供水", "闸", "泵站", "航道"],
    "公路": ["公路", "道路", "桥", "交通", "路面", "养护", "危桥", "国道", "省道", "县道", "乡道"],
    "市政": ["市政", "排水", "管网", "污水", "停车场", "城市更新", "基础设施", "环境整治", "道路提升", "照明"],
    "房建": ["房建", "厂房", "产业园", "就业中心", "教学楼", "办公楼", "仓储", "食堂", "学校", "医院", "酒店", "建筑", "车间"],
}
SERVICE_WORDS = ["勘察", "设计", "监理", "咨询", "检测", "审计", "造价", "全过程工程咨询"]
HIGH_VALUE_WORDS = ["霍邱", "高标准农田", "复垦", "水利", "河道", "防洪", "乡村振兴", "产业", "厂房", "道路", "桥", "排水"]
EXCLUDED_DEFAULT = ["竞争性谈判", "竞争性磋商", "询价", "单一来源", "中标候选人", "中标结果", "成交公告", "采购公告"]

def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def stable_id(url: str, title: str) -> str:
    q = parse_qs(urlparse(url).query)
    if q.get("infoid"):
        return q["infoid"][0]
    return hashlib.sha1(f"{url}|{title}".encode("utf-8")).hexdigest()[:24]

def infer_category(title: str) -> str | None:
    scores = {cat: sum(1 for kw in kws if kw in title) for cat, kws in CATEGORY_RULES.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else None

def parse_region(text: str) -> str:
    match = re.search(r"〖([^〗]+)〗", text)
    return match.group(1).strip() if match else "未知地区"

def clean_title(text: str) -> str:
    text = re.sub(r"〖[^〗]+〗", "", text)
    text = text.replace("公告中", "").replace("公示中", "").strip()
    return normalize(text)

def extract_publish_date(text: str) -> str:
    match = re.search(r"(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})", text)
    if not match:
        return datetime.now(CN_TZ).date().isoformat()
    y, m, d = map(int, match.groups())
    return f"{y:04d}-{m:02d}-{d:02d}"

def parse_money(text: str):
    patterns = [
        r"(?:最高投标限价|招标控制价|项目概算|预算金额|合同估算价|项目投资|总投资)[：:\s]*人民币?[约]?\s*([\d,.]+)\s*万元",
        r"(?:最高投标限价|招标控制价|预算金额)[：:\s]*人民币?\s*([\d,.]+)\s*元",
    ]
    for i, pat in enumerate(patterns):
        match = re.search(pat, text)
        if match:
            value = float(match.group(1).replace(",", ""))
            return round(value if i == 0 else value / 10000, 6)
    return None

def parse_deadline(text: str):
    context_patterns = [
        r"(?:投标文件递交截止时间|投标截止时间|开标时间)[^。；\n]{0,80}",
        r"(?:递交投标文件的截止时间)[^。；\n]{0,80}",
    ]
    candidates = []
    for pat in context_patterns:
        candidates.extend(re.findall(pat, text))
    for chunk in candidates:
        match = re.search(
            r"(20\d{2})[年\-/](\d{1,2})[月\-/](\d{1,2})日?"
            r"(?:\s*|\s*[（(]?[星期一二三四五六日天]*[）)]?\s*)"
            r"(\d{1,2})[时:：](\d{1,2})?",
            chunk,
        )
        if match:
            y, m, d, hh, mm = match.groups()
            mm = mm or "00"
            return f"{int(y):04d}-{int(m):02d}-{int(d):02d}T{int(hh):02d}:{int(mm):02d}:00+08:00"
    return None

def extract_field(text: str, labels: list[str], max_len=100):
    label_group = "|".join(map(re.escape, labels))
    match = re.search(rf"(?:{label_group})[：:\s]+([^\n。；]{{2,{max_len}}})", text)
    return normalize(match.group(1))[:max_len] if match else ""

def extract_qualification(text: str) -> str:
    keys = [
        "施工总承包", "专业承包", "建造师", "安全生产许可证", "联合体",
        "类似业绩", "项目经理", "技术负责人", "资质", "信用"
    ]
    found = []
    for line in re.split(r"[\n；。]", text):
        line = normalize(line)
        if 8 <= len(line) <= 180 and any(k in line for k in keys):
            found.append(line)
        if len(found) >= 6:
            break
    return "\n".join(dict.fromkeys(found))

def detail_data(session: requests.Session, url: str) -> dict:
    try:
        response = session.get(url, headers=HEADERS, timeout=TIMEOUT)
        response.raise_for_status()
        response.encoding = response.apparent_encoding or "utf-8"
        soup = BeautifulSoup(response.text, "html.parser")
        text = soup.get_text("\n", strip=True)
        return {
            "budgetWan": parse_money(text),
            "deadline": parse_deadline(text),
            "projectCode": extract_field(text, ["项目编号", "招标项目编号"]),
            "tenderer": extract_field(text, ["招标人", "项目实施主体"]),
            "qualification": extract_qualification(text),
            "detailTextLength": len(text),
        }
    except Exception as exc:
        print(f"[WARN] 详情抓取失败：{url}：{exc}")
        return {}

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
    if "二次" in title:
        score += 3
    if any(word in title for word in SERVICE_WORDS) and "EPC" not in title and "施工" not in title:
        score -= 15
    if item.get("budgetWan"):
        if 500 <= item["budgetWan"] <= 3000:
            score += 6
        elif item["budgetWan"] > 3000:
            score += 2
    return max(35, min(98, score))

def scrape() -> list[dict]:
    config = load_json(CONFIG_FILE, {})
    source_url = config.get("sourceUrl", "https://ggzy.luan.gov.cn/")
    excluded = config.get("excludedTerms", EXCLUDED_DEFAULT)
    allowed_categories = set(config.get("categories", ["房建", "市政", "公路", "水利"]))
    allowed_regions = set(config.get("regions", []))

    session = requests.Session()
    response = session.get(source_url, headers=HEADERS, timeout=TIMEOUT)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    soup = BeautifulSoup(response.text, "html.parser")

    output = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        raw = normalize(anchor.get_text(" ", strip=True))
        parent_text = normalize(anchor.parent.get_text(" ", strip=True)) if anchor.parent else raw
        combined = f"{parent_text} {raw}"

        if "招标公告" not in combined:
            continue
        if any(term in combined for term in excluded):
            continue

        region = parse_region(combined)
        if allowed_regions and region not in allowed_regions:
            continue

        title = clean_title(raw)
        if not title or "招标公告" == title:
            title = clean_title(combined)
        category = infer_category(title)
        if not category or category not in allowed_categories:
            continue

        url = urljoin(source_url, anchor["href"])
        item_id = stable_id(url, title)
        if item_id in seen:
            continue
        seen.add(item_id)

        item = {
            "id": item_id,
            "title": title,
            "region": region,
            "category": category,
            "publishDate": extract_publish_date(parent_text),
            "deadline": None,
            "budgetWan": None,
            "score": 0,
            "summary": "自动抓取的公开招标公告。请进入原公告查看完整招标范围、资质、评标办法和截止时间。",
            "qualification": "",
            "tenderer": "",
            "projectCode": "",
            "url": url,
            "sourceName": "六安市公共资源交易中心",
            "isEpc": "EPC" in title.upper(),
            "isSecond": "二次" in title or "第二次" in title,
            "type": "工程建设公开招标",
        }

        details = detail_data(session, url)
        for key in ("budgetWan", "deadline", "projectCode", "tenderer", "qualification"):
            if details.get(key):
                item[key] = details[key]
        item["score"] = compute_score(item)
        output.append(item)
        time.sleep(0.25)

    output.sort(key=lambda x: x.get("publishDate", ""), reverse=True)
    return output

def merge(old: list[dict], fresh: list[dict], keep_days: int) -> tuple[list[dict], int]:
    old_map = {item["id"]: item for item in old if item.get("id")}
    new_count = 0
    for item in fresh:
        previous = old_map.get(item["id"], {})
        if not previous:
            new_count += 1
        # 保留历史中已经人工补充、而本次抓取为空的字段
        for key in ("budgetWan", "deadline", "qualification", "tenderer", "projectCode", "summary"):
            if not item.get(key) and previous.get(key):
                item[key] = previous[key]
        old_map[item["id"]] = item

    cutoff = (datetime.now(CN_TZ) - timedelta(days=keep_days)).date()
    merged = []
    for item in old_map.values():
        try:
            pub = datetime.fromisoformat(item["publishDate"]).date()
        except Exception:
            pub = datetime.now(CN_TZ).date()
        if pub >= cutoff:
            merged.append(item)
    merged.sort(key=lambda x: x.get("publishDate", ""), reverse=True)
    return merged, new_count

def main():
    config = load_json(CONFIG_FILE, {})
    old = load_json(PROJECTS_FILE, [])
    try:
        fresh = scrape()
        if not fresh:
            raise RuntimeError("未提取到任何有效公告，为避免覆盖旧数据，本次停止写入。")
        merged, new_count = merge(old, fresh, int(config.get("keepDays", 180)))
        PROJECTS_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        meta = {
            "version": config.get("version", "1.0.0"),
            "updatedAt": datetime.now(CN_TZ).isoformat(timespec="seconds"),
            "sourceName": "六安市公共资源交易中心",
            "sourceUrl": config.get("sourceUrl"),
            "count": len(merged),
            "newCount": new_count,
            "status": f"自动更新成功，本次新增 {new_count} 个项目",
            "updateSchedule": config.get("updateTime", "每天北京时间09:00"),
        }
        META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] 抓取 {len(fresh)} 条，合并后 {len(merged)} 条，新增 {new_count} 条")
    except Exception as exc:
        # 失败时只更新状态，不破坏旧数据
        meta = load_json(META_FILE, {})
        meta.update({
            "lastAttemptAt": datetime.now(CN_TZ).isoformat(timespec="seconds"),
            "lastAttemptStatus": f"自动更新失败，已保留旧数据：{exc}",
        })
        META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[ERROR] {exc}", file=sys.stderr)
        raise

if __name__ == "__main__":
    main()
