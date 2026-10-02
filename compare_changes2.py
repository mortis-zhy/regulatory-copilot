"""Dump the actual 变化点总结 chapter body + CHG-format entries in both PDFs."""
import re
import unicodedata
import pypdf

VARIANTS = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
            "⽹": "网", "⻘": "青", "⼊": "入", "⽤": "用", "⾒": "见"}


def full_text(path):
    r = pypdf.PdfReader(path)
    s = "".join((p.extract_text() or "") for p in r.pages)
    s = unicodedata.normalize("NFKC", s)
    for k, v in VARIANTS.items():
        s = s.replace(k, v)
    return s


def dump(path, label):
    t = full_text(path)
    print("=" * 70)
    print(label)
    print("=" * 70)
    # All occurrences of 变化点总结 or 变化点 chapter
    positions = [m.start() for m in re.finditer(r"变化点", t)]
    print(f"'变化点' 出现 {len(positions)} 次; 'CHG' 出现 {t.count('CHG')} 次; '[新增]' {t.count('[新增]')} 次")
    # Find the LAST occurrence of 变化点总结 (actual chapter body, not TOC)
    chapter_idx = [m.start() for m in re.finditer(r"变化点总结|变化点与|变化点、", t)]
    if not chapter_idx:
        # fall back: any CHG context
        chapter_idx = [m.start() for m in re.finditer(r"CHG", t)]
    if chapter_idx:
        # take a middle occurrence (skip TOC)
        pick = chapter_idx[min(2, len(chapter_idx) - 1)]
        print(f"\n--- 章节正文片段 (pos {pick}) ---")
        print(t[pick:pick + 3500])
    print()


dump(r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf",
     "【参考报告】")
dump(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\ui-test\render-final.pdf",
     "【我们的报告】")
