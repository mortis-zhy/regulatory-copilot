# -*- coding: utf-8 -*-
"""显式 PDF → 离线要求候选与台账；不修改现有案例资料。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from requirement_discovery import discover_pdf, render_review

ROOT = Path(__file__).resolve().parent.parent
PROTECTED = ("data", "dist", "reports", "delivery", "uploaded-docs", "extract-cache", "sidecar-cache",
             ".mineru-work", ".text-cache", ".ocr-pages", ".git")


def output_path(value: str) -> Path:
    path = Path(value).resolve()
    for name in PROTECTED:
        protected = (ROOT / name).resolve()
        if path == protected or protected in path.parents:
            raise ValueError("Output is inside a protected case/artifact directory: " + str(path))
    if path.exists():
        raise ValueError("Output directory already exists; refusing to overwrite: " + str(path))
    return path


def write_outputs(path: Path, result: dict) -> None:
    # 内容先序列化和自检，再创建新目录；每个文件用 x 模式，绝不覆盖已有结果。
    outputs = {
        "discovery.json": json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        "review.md": render_review(result),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir(exist_ok=False)
    created = []
    try:
        for name, content in outputs.items():
            target = path / name
            with target.open("x", encoding="utf-8", newline="\n") as stream:
                created.append(target)
                stream.write(content)
    except Exception:
        # 仅清理本次新建且取得写入权的文件；不递归删除目录中的其他内容。
        for target in created:
            target.unlink(missing_ok=True)
        try:
            path.rmdir()
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Discover offline requirement candidates without a parameter/spec list")
    parser.add_argument("--pdf", required=True, help="Explicit source PDF; no automatic corpus selection")
    parser.add_argument("--version", required=True, help="Caller-supplied label, not a content-recognized identity")
    parser.add_argument("--pages", help="1-based physical pages, e.g. 4-8 or 4,6-8; default: all pages")
    parser.add_argument("--out", required=True, help="New output directory; existing directories are rejected")
    args = parser.parse_args(argv)
    try:
        out = output_path(args.out)
        result = discover_pdf(args.pdf, args.version, args.pages)
        write_outputs(out, result)
    except Exception as exc:
        print("Requirement discovery failed: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps({"out": str(out), "status": result["run"]["status"],
                      "candidates": result["summary"]["candidates"], "semantics": "unverified",
                      "requirementsComplete": False}, ensure_ascii=False))
    return {"complete": 0, "partial": 3, "failed": 1}[result["run"]["status"]]


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
