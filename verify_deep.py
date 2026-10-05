"""深挖争议 2 / 3 / 4：B 版用不同编号体系，需要按内容而非条款号查。"""
import re
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent
SRC = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
}
DOCS = {k: fitz.open(v) for k, v in SRC.items()}


def scan(ver, pattern, label, ctx=200, limit=3):
    rx = re.compile(pattern)
    print(f"\n[{ver}] {label}")
    n = 0
    for i, p in enumerate(DOCS[ver]):
        t = p.get_text()
        for m in rx.finditer(t):
            print(f"  p{i+1}: {t[max(0,m.start()-ctx):m.end()+ctx]}".replace("\n", " "))
            n += 1
            if n >= limit:
                return
    if not n:
        print("  (未找到)")


print("="*78)
print("争议 2 深挖：B 版示廓灯是否有「400mm → 放宽至 500mm」条款")
print("="*78)
# B 版示廓灯是 5.13（编号带空格），先确认 B 有没有示廓灯章节
scan("B", r"5\.?\s*13", "B 的 5.13 章节（示廓灯）", ctx=250, limit=2)
scan("B", r"示廓灯", "B 的示廓灯正文", ctx=250, limit=3)
scan("B", r"放宽至\s*500|可以放宽[^\n]{0,15}500", "B 的 500mm 放宽表述", ctx=250, limit=3)

print("\n" + "="*78)
print("争议 3 深挖：侧标志灯 6m / 4m")
print("="*78)
for v in ("A", "B"):
    scan(v, r"侧标志灯[^\n]{0,200}", "侧标志灯上下文", ctx=100, limit=2)
    scan(v, r"6\s*m[^\n]{0,60}(?:侧标志|标志灯|回复反射)|(?:侧标志|标志灯)[^\n]{0,60}6\s*m",
         "侧标志灯 + 6m", ctx=200, limit=2)

print("\n" + "="*78)
print("争议 4 深挖：醒目标志光色（红/白/橙）")
print("="*78)
for v in ("A", "B"):
    scan(v, r"醒目标志[^\n]{0,40}(?:颜色|光色|红|白|橙)|(?:车身反光标识|车辆尾部标志板)",
         "醒目标志 + 光色", ctx=280, limit=3)
    # 直接找 5.21 / 3.9.15 附近的颜色规定
    scan(v, r"(?:红色|白色|橙色)[^\n]{0,120}(?:标记|标志|反光)",
         "颜色 + 标记", ctx=200, limit=3)

for d in DOCS.values():
    d.close()
print("\n" + "="*78)
