"""Compare change-point sections: reference report vs our generated PDF."""
import re
import sys
import unicodedata
import pypdf

VARIANTS = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
            "⽹": "网", "⻘": "青", "⼊": "入", "⽤": "用", "⾒": "见"}


def norm(s):
    s = unicodedata.normalize("NFKC", s)
    for k, v in VARIANTS.items():
        s = s.replace(k, v)
    return s


def full_text(path):
    r = pypdf.PdfReader(path)
    return norm("".join((p.extract_text() or "") for p in r.pages))


def dump_changes(path, label, window=3000):
    t = full_text(path)
    print("=" * 70)
    print(f"{label}  ({path})")
    print("=" * 70)
    idx = t.find("变化点")
    if idx < 0:
        idx = t.find("CHG")
    if idx < 0:
        print("  未找到变化点章节")
        return
    seg = t[idx:idx + window]
    print(seg)
    print()


ref = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
ours = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\ui-test\render-final.pdf"

dump_changes(ref, "【参考报告 · 客户认可的格式】")
dump_changes(ours, "【我们生成的报告】")
