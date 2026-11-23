"""已公开开标及结果新增通知；首次执行只建基线。只使用 Actions Secret。"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "records.json"
STATE = ROOT / "data" / "notify_state.json"
CN = timezone(timedelta(hours=8))

def read(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def endpoint(key):
    import re
    if key.lower().startswith("sctp"):
        m = re.match(r"sctp(\d+)t", key, re.I)
        if not m:
            raise ValueError("无效的 Server酱 SendKey")
        return f"https://{m.group(1)}.push.ft07.com/send/{key}.send"
    return f"https://sctapi.ftqq.com/{key}.send"

def digest(projects):
    """仅公开且可核验的页面，指纹按 url+kind 去重。"""
    return sorted({hashlib.sha256((p["url"] + "|" + p["kind"]).encode()).hexdigest()[:24]
                   for p in projects if p.get("url") and p.get("kind") in {"opening","result"}})

def main():
    data = read(DATA, {"projects":[]})
    state = read(STATE, {"bootstrapped":False,"known":[]})
    current = digest(data.get("projects", []))
    known = set(state.get("known", []))
    if not state.get("bootstrapped"):
        state.update({"bootstrapped":True, "known":current,
                      "baselineAt":datetime.now(CN).isoformat(timespec="seconds")})
        write(STATE, state)
        print(f"[OK] 通知首次建基线：{len(current)} 条官方记录，不推送旧公告")
        return 0
    pending = [p for p in data.get("projects", []) if
        hashlib.sha256((p.get("url","") + "|" + p.get("kind","")).encode()).hexdigest()[:24] not in known
        and p.get("kind") in {"opening","result"}]
    if not pending:
        print("[OK] 没有新增开标/结果公告")
        return 0
    key = os.environ.get("SERVERCHAN_SENDKEY","").strip()
    if not key:
        print(f"[WARN] 有 {len(pending)} 条新增公告但未配置 SERVERCHAN_SENDKEY，保留待推送状态")
        return 0
    body = [f"本轮发现 **{len(pending)} 条** 新公开开标或结果记录。", ""]
    for p in pending[:12]:
        label = "开评标" if p["kind"] == "opening" else "中标结果"
        body.extend([
            f"### 【{label}】{p.get('title','')}",
            f"- 地区：{p.get('region','待核实')}",
            f"- 公开投标人行数：{len(p.get('quotes',[]))}",
            f"- 最终中标人：{p.get('winner') or '未确认/未识别'}",
            f"- [查看官方原文]({p.get('url')})", "",
        ])
    if len(pending)>12:
        body.append(f"另有 {len(pending)-12} 条请在情报中心查看。")
    body.extend(["[打开 KK 竞争情报中心](https://5214441.github.io/ruankao-quiz/apps/competitors/)",
                 "注意：公开样本可能不完整，以官方公告为准。"])
    response=requests.post(endpoint(key),data={
        "title":f"〖KK竞争情报〗新增{len(pending)}条开标/中标公告",
        "desp":"\n".join(body)},timeout=25)
    response.raise_for_status()
    result=response.json()
    if result.get("code") != 0:
        raise RuntimeError(f"消息接口返回失败代码：{result.get('code')}")
    state["known"]=current[-8000:]
    state["lastNotificationAt"]=datetime.now(CN).isoformat(timespec="seconds")
    write(STATE,state)
    print(f"[OK] 已发送 {len(pending)} 条公开记录微信汇总")
    return 0

if __name__=="__main__":
    sys.exit(main())
