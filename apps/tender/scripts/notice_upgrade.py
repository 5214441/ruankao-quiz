"""霍邱招投标公告升级：把澄清变更关联到原项目，绝不猜测开标时间。"""
from __future__ import annotations

import re
from typing import Callable

CHANGE_MARKER = re.compile(
    r"(?:现(?:更正|变更|修改|调整)?为|现调整为|更正后|变更后|修改后|调整后|延期至|顺延至|变更为|改为)"
)
DATE_TIME = re.compile(
    r"20\d{2}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?\s*"
    r"\d{1,2}\s*(?:时|点|[:：])\s*\d{1,2}\s*分?"
)
CHANGE_WORDS = ("更正", "变更", "澄清", "修改", "答疑", "延期", "调整")


def compact(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    text = re.sub(r"(?<=\d)\s+(?=\d|[年月日时分])", "", text)
    text = re.sub(r"(?<=[年月日时分])\s+(?=\d)", "", text)
    return text


def project_code(raw: str) -> str:
    """从表格粘连文字中仅提取项目编号；无足够依据时拒绝匹配。"""
    value = str(raw or "").upper()
    match = re.search(
        r"(?:HXJY[A-Z0-9]{10,}|E\d{10,}|FS\d{6,}(?:-[A-Z0-9]+)?|"
        r"[A-Z]{2,8}\d{4}[-A-Z0-9]{4,})",
        value,
    )
    return match.group(0) if match else ""


def comparable_title(value: str) -> str:
    value = re.sub(r"^[【\[]?(?:采购公告|招标公告|澄清与修改|更正公告)[】\]]?", "", value or "")
    value = re.sub(r"^(?:关于|针对)[“\"《]?", "", value)
    value = re.sub(r"(?:招标公告|采购公告|发包公告|交易公告|答疑澄清|澄清公告|更正公告|变更公告|补充公告|延期公告|招标文件澄清与修改).*$", "", value)
    return re.sub(r"[\s“”\"《》【】（）()·•—\-]", "", value).strip("，,。：:")[:120]


def revised_times(
    text: str,
    parse_deadline: Callable[[str], str | None],
    parse_opening: Callable[[str], str | None],
) -> dict[str, str]:
    """仅在『现更正为/延期至』等明确新值语境中抽取，防止抓到旧时间。"""
    value = compact(text)
    result: dict[str, str] = {}
    for marker in CHANGE_MARKER.finditer(value):
        before = value[max(0, marker.start() - 130):marker.start()]
        after = value[marker.end():marker.end() + 220]
        date = DATE_TIME.search(after)
        if not date or date.start() > 120:
            continue
        # 避免越过下一条事项抓到不相关的日期。
        relevant = before[-100:]
        local = after[:date.end() + 10]
        opening = bool(re.search(r"(?:开标|开启时间|响应文件开启)", relevant + local))
        deadline = bool(re.search(r"(?:投标.*截止|递交.*截止|提交.*截止|响应文件.*截止|截止时间)", relevant + local))
        if not (opening or deadline):
            continue
        raw_time = date.group(0)
        label = "开标时间" if opening else "投标文件递交截止时间"
        # 只把时间交给现有校验器，不在此自造日期。
        parsed = parse_opening(label + "：" + raw_time) if opening else parse_deadline(label + "：" + raw_time)
        if not parsed:
            continue
        if opening:
            result["openingTime"] = parsed
        if deadline:
            result["deadline"] = parse_deadline("投标文件递交截止时间：" + raw_time) or parsed
    return result


def match_original(change: dict, projects: list[dict]) -> dict | None:
    originals = [p for p in projects if p.get("noticeKind") != "change" and p.get("id") != change.get("id")]
    code = project_code(change.get("projectCode"))
    if code:
        matched = [p for p in originals if project_code(p.get("projectCode")) == code]
        if len(matched) == 1:
            return matched[0]
        if len(matched) > 1:
            return None
    title = comparable_title(change.get("title", ""))
    if len(title) < 10:
        return None
    matched = [
        p for p in originals
        if p.get("region") == change.get("region")
        and comparable_title(p.get("title", "")) == title
    ]
    return matched[0] if len(matched) == 1 else None


def attach_change_notices(projects: list[dict]) -> int:
    """按发布日期先后关联变更；只在确切匹配且有明确新时间时覆盖。"""
    applied = 0
    changes = sorted(
        (p for p in projects if p.get("noticeKind") == "change"),
        key=lambda p: (p.get("publishDate", ""), p.get("id", "")),
    )
    for change in changes:
        original = match_original(change, projects)
        if not original:
            continue
        notices = list(original.get("changeNotices") or [])
        if any(item.get("id") == change["id"] for item in notices):
            continue
        record = {
            "id": change["id"],
            "title": change["title"],
            "date": change.get("publishDate"),
            "url": change.get("url"),
        }
        update = change.get("revisedTimes") or {}
        # 防止回溯时较旧的公告反向覆盖最新时间。
        latest_date = max((str(x.get("date") or "") for x in notices), default="")
        can_apply = str(change.get("publishDate") or "") >= latest_date
        for field in ("deadline", "openingTime"):
            if can_apply and update.get(field) and update[field] != original.get(field):
                record[field + "Before"] = original.get(field)
                record[field + "After"] = update[field]
                original[field] = update[field]
                original[field + "SourceUrl"] = change.get("url")
                applied += 1
        notices.append(record)
        original["changeNotices"] = notices[-30:]
        original["lastChangeDate"] = max(latest_date, str(change.get("publishDate") or ""))
        change["relatedProjectId"] = original["id"]
        change["relatedProjectTitle"] = original.get("title", "")
    return applied
