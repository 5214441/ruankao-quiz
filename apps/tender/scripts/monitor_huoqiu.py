#!/usr/bin/env python3
"""
霍邱招标雷达 V1.2

功能：
1. 读取 projects.json，监控霍邱县新发布的工程建设公开招标项目。
2. 对土地复垦、高标准农田、行蓄洪居民迁建配套、农田水利、
   市政道路、厂房工程等重点词进行标记。
3. 只对“未通知过”的新项目发送微信消息，避免重复。
4. 同一轮多个项目合并成一条消息，减少通知频率。
5. SendKey 只从环境变量 SERVERCHAN_SENDKEY 读取，不写入仓库。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
PROJECTS_FILE = ROOT / "data" / "projects.json"
META_FILE = ROOT / "data" / "meta.json"
MONITOR_CONFIG_FILE = ROOT / "monitor_config.json"
STATE_FILE = ROOT / "data" / "monitor_state.json"
STATUS_FILE = ROOT / "data" / "monitor_status.json"

CN_TZ = timezone(timedelta(hours=8))
REQUEST_TIMEOUT = 25


def now() -> datetime:
    return datetime.now(CN_TZ)


def now_iso() -> str:
    return now().isoformat(timespec="seconds")


def load_json(path: Path, default: Any):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def project_text(project: dict) -> str:
    return normalize(" ".join([
        project.get("title", ""),
        project.get("region", ""),
        project.get("category", ""),
        project.get("summary", ""),
        project.get("qualification", ""),
        project.get("tenderer", ""),
    ]))


def is_pure_service(project: dict) -> bool:
    text = project_text(project)
    return bool(
        re.search(r"勘察|设计|监理|咨询|检测|审计|造价|全过程工程咨询", text)
        and not re.search(r"EPC|总承包|施工", text, re.I)
    )


def is_huoqiu(project: dict, config: dict) -> bool:
    if normalize(project.get("region")) == "霍邱县":
        return True
    text = project_text(project)
    return any(keyword in text for keyword in config.get("regionKeywords", ["霍邱", "霍邱县"]))


def matched_keywords(project: dict, config: dict) -> list[str]:
    text = project_text(project)
    return [
        keyword for keyword in config.get("priorityKeywords", [])
        if keyword and keyword in text
    ]


def parse_date(value: Any):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except Exception:
        return None


def eligible_projects(projects: list[dict], config: dict) -> list[dict]:
    cutoff = now().date() - timedelta(days=int(config.get("monitorDays", 45)))
    output = []
    for project in projects:
        if not project.get("id"):
            continue
        if not is_huoqiu(project, config):
            continue
        if config.get("excludePureService", True) and is_pure_service(project):
            continue
        publish_date = parse_date(project.get("publishDate"))
        if publish_date and publish_date < cutoff:
            continue
        item = dict(project)
        item["_matchedKeywords"] = matched_keywords(project, config)
        output.append(item)

    output.sort(
        key=lambda item: (
            str(item.get("publishDate", "")),
            int(item.get("score", 0) or 0),
        ),
        reverse=True,
    )
    return output


def budget_text(value: Any) -> str:
    try:
        number = float(value)
        return f"{number:,.2f}万元".replace(".00万元", "万元")
    except Exception:
        return "未识别"


def deadline_text(value: Any) -> str:
    if not value:
        return "未识别"
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.astimezone(CN_TZ).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(value)


def serverchan_endpoint(sendkey: str) -> str:
    sendkey = sendkey.strip()
    if sendkey.lower().startswith("sctp"):
        match = re.match(r"sctp(\d+)t", sendkey, re.I)
        if not match:
            raise ValueError("无法从 sctp SendKey 中识别 UID")
        return f"https://{match.group(1)}.push.ft07.com/send/{sendkey}.send"
    return f"https://sctapi.ftqq.com/{sendkey}.send"


def send_serverchan(sendkey: str, title: str, body: str) -> dict:
    response = requests.post(
        serverchan_endpoint(sendkey),
        data={"title": title.replace("\n", " ")[:128], "desp": body},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    try:
        result = response.json()
    except Exception as exc:
        raise RuntimeError("微信接口没有返回有效JSON") from exc

    if int(result.get("code", -1)) != 0:
        raise RuntimeError(result.get("message") or result.get("msg") or f"接口返回 code={result.get('code')}")
    return result


def build_message(projects: list[dict], config: dict) -> tuple[str, str]:
    total = len(projects)
    title = f"〖霍邱招标雷达〗发现{total}个新项目"
    max_items = int(config.get("maxItemsPerMessage", 8))
    dashboard_url = config.get(
        "dashboardUrl",
        "https://5214441.github.io/ruankao-quiz/apps/tender/",
    )

    parts = [
        f"本次发现 **{total} 个霍邱县新招标项目**。",
        "",
    ]
    for index, project in enumerate(projects[:max_items], start=1):
        tags = project.get("_matchedKeywords") or []
        tag_text = "、".join(tags[:6]) if tags else "霍邱县工程项目"
        parts.extend([
            f"### {index}. {normalize(project.get('title'))}",
            f"- 类别：{normalize(project.get('category')) or '未识别'}",
            f"- 发布：{normalize(project.get('publishDate')) or '未识别'}",
            f"- 预算：{budget_text(project.get('budgetWan'))}",
            f"- 截止：{deadline_text(project.get('deadline'))}",
            f"- 适配评分：{int(project.get('score', 0) or 0)}分",
            f"- 命中关键词：{tag_text}",
            f"- [查看原公告]({project.get('url', dashboard_url)})",
            "",
        ])

    if total > max_items:
        parts.append(f"其余 {total - max_items} 个项目请进入看板查看。")
        parts.append("")

    parts.extend([
        f"[打开霍邱·六安招投标信息看板]({dashboard_url})",
        "",
        "> 公开信息仅供筛选，投标前请核对原公告和招标文件。",
    ])
    return title, "\n".join(parts)


def build_test_message(config: dict) -> tuple[str, str]:
    keywords = "、".join(config.get("priorityKeywords", [])[:12])
    return (
        "〖霍邱招标雷达〗微信提醒测试成功",
        "\n".join([
            "GitHub Actions 已成功连接微信提醒。",
            "",
            f"- 监控地区：霍邱县",
            f"- 运行时间：{config.get('scheduleText', '每天北京时间09:17')}",
            f"- 重点词：{keywords}",
            "",
            "以后只有发现未通知过的新项目时，才会发送项目汇总。",
        ]),
    )


def update_status(config: dict, **patch) -> dict:
    status = load_json(STATUS_FILE, {})
    status.update({
        "version": "1.2.0",
        "enabled": bool(config.get("enabled", True)),
        "scheduleText": config.get("scheduleText", "每天北京时间09:17"),
        "keywords": config.get("priorityKeywords", []),
        "regionKeywords": config.get("regionKeywords", ["霍邱", "霍邱县"]),
        **patch,
    })
    write_json(STATUS_FILE, status)
    return status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true", help="发送一条微信测试消息")
    parser.add_argument("--dry-run", action="store_true", help="只打印消息，不调用微信接口")
    args = parser.parse_args()

    config = load_json(MONITOR_CONFIG_FILE, {})
    projects = load_json(PROJECTS_FILE, [])
    meta = load_json(META_FILE, {})
    state = load_json(STATE_FILE, {
        "version": "1.2.0",
        "bootstrapped": False,
        "knownProjectIds": [],
        "lastNotificationAt": None,
        "lastFailureAlertDate": None,
    })

    sendkey = os.environ.get("SERVERCHAN_SENDKEY", "").strip()
    channel_configured = bool(sendkey)
    fetch_outcome = os.environ.get("TENDER_FETCH_OUTCOME", "").strip().lower()

    matches = eligible_projects(projects, config)
    known = set(state.get("knownProjectIds", []))

    # 首次启用时，以当前项目作为基线，避免一次性把历史项目全部推送。
    if not state.get("bootstrapped"):
        known.update(item["id"] for item in matches)
        state["bootstrapped"] = True
        state["knownProjectIds"] = list(known)[-2000:]
        state["lastBootstrapAt"] = now_iso()
        write_json(STATE_FILE, state)
        update_status(
            config,
            channelConfigured=channel_configured,
            status="ready" if channel_configured else "not_configured",
            statusText="监控基线已建立，等待新项目" if channel_configured else "监控基线已建立，尚未配置微信SendKey",
            lastCheckAt=now_iso(),
            matchedProjectCount=len(matches),
            pendingCount=0,
            lastNotificationAt=state.get("lastNotificationAt"),
        )
        print(f"[INFO] 首次运行已建立基线：{len(matches)} 个霍邱项目，不发送历史消息。")

    if args.test:
        title, body = build_test_message(config)
        if args.dry_run:
            print(title)
            print(body)
            return 0
        if not channel_configured:
            update_status(
                config,
                channelConfigured=False,
                status="not_configured",
                statusText="测试失败：尚未配置 SERVERCHAN_SENDKEY",
                lastCheckAt=now_iso(),
                matchedProjectCount=len(matches),
                pendingCount=0,
                lastNotificationAt=state.get("lastNotificationAt"),
            )
            print("[ERROR] 尚未配置 SERVERCHAN_SENDKEY", file=sys.stderr)
            return 2
        send_serverchan(sendkey, title, body)
        state["lastNotificationAt"] = now_iso()
        write_json(STATE_FILE, state)
        update_status(
            config,
            channelConfigured=True,
            status="test_ok",
            statusText="微信测试消息发送成功",
            lastCheckAt=now_iso(),
            matchedProjectCount=len(matches),
            pendingCount=0,
            lastNotificationAt=state["lastNotificationAt"],
        )
        print("[OK] 微信测试消息发送成功")
        return 0

    # 抓取失败时每天最多提醒一次。
    if (
        fetch_outcome == "failure"
        and config.get("sendFetchFailureNotice", True)
        and channel_configured
    ):
        today = now().date().isoformat()
        if state.get("lastFailureAlertDate") != today:
            failure_reason = meta.get("lastAttemptStatus") or "自动抓取未成功，请进入GitHub Actions查看日志。"
            title = "〖霍邱招标雷达〗今日抓取失败"
            body = "\n".join([
                "今天的招投标自动抓取没有成功，系统已保留上一次有效项目数据。",
                "",
                f"- 时间：{now().strftime('%Y-%m-%d %H:%M')}",
                f"- 原因：{failure_reason}",
                "",
                f"[打开看板]({config.get('dashboardUrl')})",
            ])
            try:
                send_serverchan(sendkey, title, body)
                state["lastFailureAlertDate"] = today
                write_json(STATE_FILE, state)
            except Exception as exc:
                print(f"[WARN] 抓取失败提醒发送失败：{exc}", file=sys.stderr)

    new_projects = [item for item in matches if item["id"] not in known]

    if not new_projects:
        update_status(
            config,
            channelConfigured=channel_configured,
            status="no_new" if channel_configured else "not_configured",
            statusText="本次未发现新的霍邱项目" if channel_configured else "未配置微信SendKey，监控仍会记录状态",
            lastCheckAt=now_iso(),
            matchedProjectCount=len(matches),
            pendingCount=0,
            lastNotificationAt=state.get("lastNotificationAt"),
        )
        print(f"[OK] 当前霍邱匹配项目 {len(matches)} 个，本次没有新项目。")
        return 0

    title, body = build_message(new_projects, config)
    if args.dry_run:
        print(title)
        print(body)
        return 0

    if not channel_configured:
        update_status(
            config,
            channelConfigured=False,
            status="pending",
            statusText=f"发现 {len(new_projects)} 个新项目，但尚未配置微信SendKey",
            lastCheckAt=now_iso(),
            matchedProjectCount=len(matches),
            pendingCount=len(new_projects),
            lastNotificationAt=state.get("lastNotificationAt"),
        )
        print(f"[WARN] 有 {len(new_projects)} 个新项目待推送，但未配置 SERVERCHAN_SENDKEY。")
        return 0

    try:
        send_serverchan(sendkey, title, body)
    except Exception as exc:
        update_status(
            config,
            channelConfigured=True,
            status="error",
            statusText=f"微信推送失败：{exc}",
            lastCheckAt=now_iso(),
            matchedProjectCount=len(matches),
            pendingCount=len(new_projects),
            lastNotificationAt=state.get("lastNotificationAt"),
        )
        print(f"[ERROR] 微信推送失败：{exc}", file=sys.stderr)
        return 1

    # 仅在推送成功后标记为已知，失败时下次会自动重试。
    known.update(item["id"] for item in new_projects)
    state["knownProjectIds"] = list(known)[-2000:]
    state["lastNotificationAt"] = now_iso()
    state["lastNotificationProjectIds"] = [item["id"] for item in new_projects]
    write_json(STATE_FILE, state)
    update_status(
        config,
        channelConfigured=True,
        status="sent",
        statusText=f"已推送 {len(new_projects)} 个霍邱新项目",
        lastCheckAt=now_iso(),
        matchedProjectCount=len(matches),
        pendingCount=0,
        lastNotificationAt=state["lastNotificationAt"],
    )
    print(f"[OK] 已发送微信提醒：{len(new_projects)} 个新项目。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
