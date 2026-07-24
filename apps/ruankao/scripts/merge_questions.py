#!/usr/bin/env python3
"""Merge valid files from incoming/ into data/questions.json when enough new questions exist."""
from __future__ import annotations
import argparse, json, re
from datetime import datetime, timezone
from pathlib import Path
from validate_questions import validate

ROOT=Path(__file__).resolve().parents[1]

def read_questions(path:Path):
    data=json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data,dict): data=data.get("questions",data)
    if not isinstance(data,list): raise ValueError(f"{path}: root must be list")
    return data

def next_id(existing):
    nums=[int(m.group(1)) for q in existing if (m:=re.fullmatch(r"q(\d+)",str(q.get("id",""))))]
    return max(nums,default=0)+1

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--min-new",type=int,default=10);ap.add_argument("--force",action="store_true");args=ap.parse_args()
    bank_path=ROOT/"data/questions.json";version_path=ROOT/"data/version.json";incoming_dir=ROOT/"incoming"
    bank=read_questions(bank_path);ids={q["id"] for q in bank};texts={q["text"].strip() for q in bank};candidates=[];processed=[]
    files=[p for p in incoming_dir.glob("*.json") if not p.name.endswith(".example.json")]
    for p in files:
        try:items=read_questions(p)
        except Exception as e: print(f"skip {p.name}: {e}");continue
        for q in items:
            if not isinstance(q,dict): continue
            if q.get("id") in ids or str(q.get("text","")).strip() in texts: continue
            candidates.append(q)
        processed.append(p)
    if not candidates:
        print("No new candidate questions.");return 0
    # Normalize missing IDs sequentially.
    nid=next_id(bank)
    for q in candidates:
        if not q.get("id"):
            q["id"]=f"q{nid:03d}";nid+=1
    combined=bank+candidates
    errors=validate(combined)
    if errors:
        print("Candidate merge rejected:")
        for e in errors[:100]: print(" -",e)
        return 1
    if len(candidates)<args.min_new and not args.force:
        print(f"Only {len(candidates)} valid new questions; minimum is {args.min_new}. No merge.")
        return 0
    bank_path.write_text(json.dumps(combined,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    version=json.loads(version_path.read_text(encoding="utf-8"));now=datetime.now(timezone.utc)
    version["questionCount"]=len(combined);version["updatedAt"]=now.date().isoformat();version["questionVersion"]=now.strftime("%Y.%m.%d.%H%M")
    version["updateNotes"]=[f"自动合并 {len(candidates)} 道审核格式通过的新题"]+list(version.get("updateNotes",[]))[:4]
    version_path.write_text(json.dumps(version,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    archive=incoming_dir/"processed"/now.strftime("%Y%m%d-%H%M%S");archive.mkdir(parents=True,exist_ok=True)
    for p in processed:p.rename(archive/p.name)
    print(f"Merged {len(candidates)} questions; total {len(combined)}")
    return 0
if __name__=="__main__": raise SystemExit(main())
