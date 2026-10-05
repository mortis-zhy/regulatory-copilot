"""给渲染好的 PDF 打书签（outline）。

为什么需要：111 页 PDF 在浏览器 / 阅读器里打开时侧边栏完全空白，
读者只能靠滚动条或全文搜索定位。Chromium 不会自动为 <h2> 生成书签。

用法:
    python stamp_bookmarks.py <in.pdf> <out.pdf> '<json>'
其中 json 是 [{"title": "...", "page": 3}, ...]

用 PyMuPDF（服务端已在用它做锚点找页码，同一个依赖）：
    doc.set_toc(toc) → doc.save(out, incremental=False)
"""
import json
import sys

import fitz  # PyMuPDF


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst, toc_json = sys.argv[1], sys.argv[2], sys.argv[3]
    items = json.loads(toc_json)
    # Drop entries with no page — the anchor pass may not have resolved them.
    toc = [[1, it["title"], int(it["page"])] for it in items if int(it.get("page") or 0) > 0]
    if len(toc) < 2:
        print("bookmarks skipped: fewer than 2 resolved entries")
        return 0
    doc = fitz.open(src)
    doc.set_toc(toc)
    doc.save(dst)
    doc.close()
    print(f"bookmarks stamped: {len(toc)} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())