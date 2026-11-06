#!/usr/bin/env python3
"""
MinerU v4 SDK extraction — final version.

Correct API discovered by probing:
  result.structured_content() → {'pages': [{page_idx, blocks: [{type, bbox, content, ...}]}], ...}
  block types: header / doc_title / paragraph_title / index / text / table / image / equation / footer
  result.markdown() → full markdown string

Output: dist/mineru-v4-data.json
"""
import ssl, os, json, sys, io, time
from pathlib import Path
from collections import Counter
from scripts.standard_pack import source_pdfs
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ssl._create_default_https_context = ssl._create_unverified_context

# 仓库根。COMPARE_AGENT_ROOT 指**仓库本身**。
# 原来这里取 `.parent.parent`（= 仓库外那个「工作台」目录），还要再拼一层
# "comparison_agent-main" 才落回仓库 —— 同事克隆到别的路径就全错位。
ROOT = Path(os.environ.get("COMPARE_AGENT_ROOT", Path(__file__).resolve().parent))
OUT_DIR = ROOT / "dist" / "mineru-v4-data.json"

# 三份源 PDF 在仓库内 delivery/PDF对比/（原先是仓库外那三份按旧文件名命名的副本，
# 与这几份字节完全相同 —— sha256 一致）。
PDFS = source_pdfs(ROOT)

def sha256_file(path) -> str:
    """源 PDF 的 SHA-256 —— 语料与源文件之间的钥匙。"""
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_one(label, pdf_path):
    print(f"\n[mineru-v4] {label}: {pdf_path.name}")
    if not pdf_path.exists():
        return None
    try:
        from mineru import MinerUParser
        parser = MinerUParser(tier="standard", parse_mode="auto", image_analysis=True)
        t0 = time.time()
        result = parser.parse(pdf_path)
        elapsed = time.time() - t0

        md = result.markdown() or ""
        structured = result.structured_content()

        types = Counter()
        tables, figures, equations = [], [], []
        headings = []
        full_text_parts = []  # page-tagged plain text

        for pg in structured.get("pages", []):
            pno = pg.get("page_idx", 0) + 1
            page_texts = []
            for blk in pg.get("blocks", []):
                t = blk.get("type", "unknown")
                content = blk.get("content") or blk.get("text") or ""
                types[t] += 1
                if t in ("table",):
                    tables.append({
                        "page": pno,
                        "content": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False),
                        "caption": blk.get("caption", ""),
                    })
                    page_texts.append(content if isinstance(content, str) else "")
                elif t == "image":
                    figures.append({"page": pno, "caption": blk.get("caption", "") or content})
                elif t == "equation":
                    equations.append({"page": pno, "latex": blk.get("latex", "") or content})
                elif t in ("doc_title", "paragraph_title", "heading"):
                    lvl = blk.get("level", 1)
                    headings.append({"page": pno, "level": lvl, "title": str(content)})
                    page_texts.append(str(content))
                elif t in ("text", "interline_equation", "index", "header", "footer"):
                    if isinstance(content, str):
                        page_texts.append(content)
                else:
                    if isinstance(content, str):
                        page_texts.append(content)
            if page_texts:
                full_text_parts.append(f"[第{pno}页]\n" + "\n".join(page_texts))

        print(f"  parsed in {elapsed:.1f}s | md={len(md)} chars")
        print(f"  blocks: {dict(types)}")
        print(f"  tables={len(tables)} figures={len(figures)} equations={len(equations)} headings={len(headings)}")

        return {
            "fileName": pdf_path.name,
            # **语料自述来源** —— 有了它，sidecar 才能在缓存缺失时
            # 认出「这就是仓库里那份已入库的语料对应的源文件」，
            # 而不是重新抽一遍得到一个**内容略有不同**的副本。
            # （LaTeX 花括号位置会差一位，报告就不逐字节相同了。）
            "sourceSha256": sha256_file(pdf_path),
            "extractionTime": elapsed,
            "markdown": md,
            "fullText": "\n".join(full_text_parts),
            "blockTypes": dict(types),
            "tables": tables,
            "figures": figures,
            "equations": equations,
            "headings": headings,
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"  FAIL: {type(e).__name__}: {str(e)[:300]}")
        return None

def main():
    OUT_DIR.parent.mkdir(parents=True, exist_ok=True)
    results = {}
    for label, pdf_path in PDFS.items():
        r = extract_one(label, pdf_path)
        if r:
            results[label] = r

    with open(OUT_DIR, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    size_mb = OUT_DIR.stat().st_size / (1024 * 1024)
    print(f"\n[mineru-v4] Saved {len(results)} docs to {OUT_DIR} ({size_mb:.1f} MB)")
    for label, r in results.items():
        print(f"  {label}: md={len(r['markdown'])//1024}KB text={len(r['fullText'])//1024}KB "
              f"tables={len(r['tables'])} figs={len(r['figures'])} eqs={len(r['equations'])} heads={len(r['headings'])}")

if __name__ == "__main__":
    main()