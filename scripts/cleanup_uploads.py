#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""清**旧的上传件与旧报告** ✓ —— 磁盘不会自己长满 ✓。

## 为什么要有

公司服务器上「上传的源 PDF」与「生成的任务报告」都**永久保留** ✓ ⇒
跑久了磁盘会满 ✓ ⇒ **服务会挂** ✓（写不进去 ⇒ 上传失败 ⇒ 看着像应用坏了 ✗）。

## 原则：**默认只看不动** ✓

- 默认 **dry-run** ✓ —— 只报「会删什么」✓，**不删** ✓；
- 真删要加 `--apply` ✓（这是**不可逆**的操作 ✓ ⇒ 必须显式 ✓）。

## 用法

```bash
python scripts/cleanup_uploads.py --older-than 30          # 只看（默认）✓
python scripts/cleanup_uploads.py --older-than 30 --apply  # 真删 ✓
python scripts/cleanup_uploads.py --older-than 30 --json   # 机器读 ✓
```

⚠ **不会碰**案例包的源 PDF ✓（`uploaded-docs/README.md` 说的那几份是**入库语料** ✓，
删了报告就出不来 ✓）⇒ 默认**跳过**清单里点名的文件 ✓。
"""
import argparse
import io
import json
import os
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS = os.path.join(ROOT, "uploaded-docs")
TASKS = os.path.join(ROOT, "reports", "tasks")
# **入库语料**（案例包的三份源 PDF ✓）⇒ 永远不删 ✓。
PROTECTED = {"2173836fae9f1314.pdf", "92b2563197df022a.pdf", "f86e6c7367f24de2.pdf"}


def older_than(path, days, now):
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return False
    return (now - mt) > days * 86400


def collect(upload_dir, task_dir, days, now):
    items = []
    if os.path.isdir(upload_dir):
        for name in sorted(os.listdir(upload_dir)):
            if name in PROTECTED or name == "README.md":
                continue
            p = os.path.join(upload_dir, name)
            if not os.path.isfile(p):
                continue
            if older_than(p, days, now):
                items.append({"kind": "upload", "path": p, "bytes": os.path.getsize(p)})
    if os.path.isdir(task_dir):
        for name in sorted(os.listdir(task_dir)):
            p = os.path.join(task_dir, name)
            if not os.path.isdir(p):
                continue
            if older_than(p, days, now):
                size = 0
                for root, _dirs, files in os.walk(p):
                    for f in files:
                        try:
                            size += os.path.getsize(os.path.join(root, f))
                        except OSError:
                            pass
                items.append({"kind": "task", "path": p, "bytes": size})
    return items


def main():
    ap = argparse.ArgumentParser(description="清理旧上传件与旧任务报告")
    ap.add_argument("--older-than", type=int, default=30, help="超过多少天算旧（默认 30）")
    ap.add_argument("--apply", action="store_true", help="**真删** ✓（默认只报 ✓）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    now = time.time()
    items = collect(UPLOADS, TASKS, args.older_than, now)
    total = sum(i["bytes"] for i in items)

    deleted = []
    if args.apply:
        import shutil

        for it in items:
            try:
                if it["kind"] == "task":
                    shutil.rmtree(it["path"])
                else:
                    os.remove(it["path"])
                deleted.append(it["path"])
            except OSError as e:
                print("删不掉：%s（%s）" % (it["path"], e), file=sys.stderr)

    out = {
        "olderThanDays": args.older_than,
        "apply": bool(args.apply),
        "candidates": len(items),
        "bytes": total,
        "deleted": len(deleted),
        "items": items,
    }
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    print("超过 %d 天的旧件：%d 个 · 合计 %.1f MB" % (args.older_than, len(items), total / 1024 / 1024))
    for it in items:
        print("  [%s] %s（%.1f MB）" % (it["kind"], it["path"], it["bytes"] / 1024 / 1024))
    if args.apply:
        print("已删除 %d 个 ✓" % len(deleted))
    else:
        print("（**没有删任何东西** ✓ —— 真删加 --apply ✓）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
