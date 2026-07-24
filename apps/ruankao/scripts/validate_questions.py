#!/usr/bin/env python3
"""Validate the static question bank. Exits non-zero on structural errors."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

REQUIRED = {"id","category","knowledge","difficulty","type","text","options","answer","explanation"}
TYPES = {"concept","scenario","calculation"}

def load(path: Path):
    data=json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data,dict) and isinstance(data.get("questions"),list): data=data["questions"]
    if not isinstance(data,list): raise ValueError("root must be a JSON array")
    return data

def validate(data):
    errors=[]; ids=set(); texts=set()
    for i,q in enumerate(data,1):
        p=f"question {i}"
        if not isinstance(q,dict): errors.append(f"{p}: must be an object"); continue
        missing=REQUIRED-set(q)
        if missing: errors.append(f"{p}: missing {sorted(missing)}")
        qid=q.get("id")
        if not isinstance(qid,str) or not qid.strip(): errors.append(f"{p}: invalid id")
        elif qid in ids: errors.append(f"{p}: duplicate id {qid}")
        else: ids.add(qid)
        text=q.get("text")
        if not isinstance(text,str) or len(text.strip())<5: errors.append(f"{p}: invalid text")
        elif text.strip() in texts: errors.append(f"{p}: duplicate text")
        else: texts.add(text.strip())
        options=q.get("options")
        if not isinstance(options,list) or len(options)!=4 or any(not isinstance(x,str) or not x.strip() for x in options): errors.append(f"{p}: options must contain four non-empty strings")
        answer=q.get("answer")
        if not isinstance(answer,int) or answer not in range(4): errors.append(f"{p}: answer must be 0..3")
        if q.get("type") not in TYPES: errors.append(f"{p}: invalid type")
        if q.get("difficulty") not in (1,2,3): errors.append(f"{p}: difficulty must be 1,2,3")
        if not isinstance(q.get("explanation"),str) or len(q.get("explanation","").strip())<5: errors.append(f"{p}: explanation too short")
    return errors

def main():
    ap=argparse.ArgumentParser();ap.add_argument("path",nargs="?",default="data/questions.json");args=ap.parse_args()
    path=Path(args.path)
    try:data=load(path);errors=validate(data)
    except Exception as e: print(f"ERROR: {e}",file=sys.stderr);return 2
    if errors:
        for e in errors: print(f"ERROR: {e}",file=sys.stderr)
        print(f"Validation failed: {len(errors)} error(s)",file=sys.stderr);return 1
    print(f"Validation passed: {len(data)} questions")
    return 0
if __name__=="__main__": raise SystemExit(main())
