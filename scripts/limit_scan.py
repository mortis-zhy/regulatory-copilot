# -*- coding: utf-8 -*-
"""条款正文里的**限值**扫描 —— 覆盖审计与条款核对共用同一份解析。

为什么必须是同一份：审计说「漏了」、核对说「没错」，客户没法判断是哪边错。
早先两边的口径不一致（审计认 `deg`/`cm2`、核对只认 `°`/`cm²`），
于是同一个值在两处得到两个结论，只能靠人肉裁决。

这一版处理掉的写法（都在三份标准里真实出现）：

- **括号 + 公差**：「（4.0±1.0）Hz」「(90±30)次/min」—— 单位跟在右括号后，
  早先的正则看不到任何数，只留下公差里的 1.0。
- **英文数字**：「one and one-half seconds」「two minutes」—— R48 常用。
- **中文单位**：「2 分钟以上」「15 cm²」「次/min」。
- **脚注编号**：「140 mm13」「10 cm 2」—— 尾随数字把单位顶掉了。
- **百分数单独成词**：「within an accuracy of 0.1 per cent」—— 数字后面
  没有别的单位，单位就是 per cent 本身。
- **英文单位**：degree / lux / lumen / second / square centimetres / times per minute。

每个量值都归一到一个**规范单位**（长度→mm、面积→mm²、时间→s……），
这样矩阵里写 `m`、原文写 `mm` 时也能对上。
"""
import re

# ---------------------------------------------------------------- 数值

WORD_NUM = {
    "one and one-half": 1.5, "one and a half": 1.5, "one-half": 0.5, "a half": 0.5,
    "one": 1.0, "two": 2.0, "three": 3.0, "four": 4.0, "five": 5.0, "six": 6.0,
    "seven": 7.0, "eight": 8.0, "nine": 9.0, "ten": 10.0, "eleven": 11.0,
    "twelve": 12.0, "fifteen": 15.0, "twenty": 20.0, "thirty": 30.0,
    "forty": 40.0, "fifty": 50.0, "sixty": 60.0, "hundred": 100.0,
}
_WORD_ALT = "|".join(
    re.escape(k).replace(r"\ ", r"[\s\-]+") for k in sorted(WORD_NUM, key=len, reverse=True)
)

# ---------------------------------------------------------------- 单位
# 顺序即优先级：长写法在前（cm2 要先于 cm，square centimetres 要先于 s…）。
# 注意**不能加 \b**：Python 的 \w 含汉字，「3s内」的 "s" 后面跟汉字就没有词边界，
# 加了 \b 就检不出来（这正是早先漏掉「3s」「2 分钟」的原因）。
UNIT_PATTERNS = [
    (r"cd\s*/\s*m\s*(?:2|²)", "cd/m²"),
    (r"square\s+centimet(?:re|er)s?", "cm²"),
    (r"square\s+millimet(?:re|er)s?", "mm²"),
    (r"square\s+met(?:re|er)s?", "m²"),
    (r"times\s+per\s+minute", "次/min"),
    (r"次\s*/\s*分\s*钟?", "次/min"),
    (r"次\s*/\s*min", "次/min"),
    (r"per\s+cent", "%"),
    (r"percent", "%"),
    (r"km\s*/\s*h|kmh", "km/h"),
    (r"mm\s*(?:2|²)", "mm²"),
    (r"㎝", "cm²"),
    (r"cm\s*(?:2|²)", "cm²"),
    (r"㎜", "mm"),
    (r"毫米", "mm"),
    (r"厘米", "cm"),
    (r"公分", "cm"),
    (r"degrees?", "°"),
    (r"°|º|度", "°"),
    (r"lumens?", "lm"),
    (r"minutes?", "min"),
    (r"分钟", "min"),
    (r"seconds?", "s"),
    (r"秒", "s"),
    (r"lux", "lx"),
    (r"lx", "lx"),
    (r"Hz", "Hz"),
    (r"cd", "cd"),
    (r"Nm", "Nm"),
    (r"V", "V"),
    (r"W", "W"),
    (r"mm", "mm"),
    (r"cm", "cm"),
    (r"met(?:re|er)s?", "m"),
    (r"米", "m"),
    (r"m\s*(?:2|²)", "m²"),
    (r"%", "%"),
    (r"m", "m"),
    (r"s", "s"),
    (r"min", "min"),
]


def _unit_regex():
    parts = []
    for i, (pat, _c) in enumerate(UNIT_PATTERNS):
        parts.append("(?P<u%d>%s)" % (i, pat))
    return "|".join(parts)


_UNIT_CANON = {("u%d" % i): c for i, (_p, c) in enumerate(UNIT_PATTERNS)}

# 规范单位 → (基准量纲, 比例)。同量纲才可比。
BASE = {
    "mm": ("mm", 1.0), "cm": ("mm", 10.0), "m": ("mm", 1000.0),
    "mm²": ("mm²", 1.0), "cm²": ("mm²", 100.0), "m²": ("mm²", 1e6),
    "°": ("°", 1.0),
    "s": ("s", 1.0), "min": ("s", 60.0),
}

# ---------------------------------------------------------------- 主正则
_NUM_ALT = r"(?:\d+(?:[,\s]\d{3})*(?:\.\d+)?|%s)" % _WORD_ALT
# 英文数字后面**不能紧跟字母** —— 否则复数会被读成「1 秒」：
#   「the mandatory one|s i|s compatible」→ 1 s
# （C §6.13.4.2 的量值就是这么冒出来的）
# 数字写法不受影响：「3s内」这种「数字+单位」没有空格，是常见写法。
_WORD_NUM_ALT = r"(?:%s)(?![A-Za-z])" % _WORD_ALT
VAL = re.compile(
    # 数字不能紧跟在 ASCII 字母或破折号后面：否则「GB4785—2019」的 2019、
    # 「W12」的 12 都会被当成量值。
    r"(?<![\d.])(?<![A-Za-z—–])(?P<num>(?:\d+(?:[,\s]\d{3})*(?:\.\d+)?|" + _WORD_NUM_ALT + r"))"
    # 公差：「（4.0±1.0）Hz」「90 ± 30 times per minute」
    r"(?:\s*(?:±|\+/-|\+-)\s*\d+(?:\.\d+)?)?"
    # 右括号（「（4.0±1.0）Hz」的单位在括号外）
    r"\s*[)）]?"
    r"\s*(?P<uwrap>" + _unit_regex() + r")"
    # 单位后面可以跟脚注编号（140 mm13），但不能紧跟 ASCII 字母
    r"(?!(?:\d{1,2})?[A-Za-z°º])",
    re.I,
)

# GB 2019 的 PDF 把每个数字都拆开：「12.\n5cm」「4. 0±1. 0」。
BROKEN_NUM = re.compile(r"(?<=\d)\s*\.\s*(?=\d)")
# 无单位的数（色度坐标 0.310、参考值 100、TTC 1.4 这类）
DECIMAL = re.compile(r"(?<![\d.])(?<![\w])\d+\.\d+")
INTEGER = re.compile(r"(?<![\d.])(?<![\w.])\d+(?![\d.])(?![\w.])")


def _parse_num(raw):
    """把匹配到的数字串变成 float（英文数字查表，数字串去掉千分位）。"""
    s = re.sub(r"\s+", " ", raw.strip().lower())
    # 英文数字：连字符与空格都抹掉再查表（"one and one-half" → "oneandonehalf"）
    key = re.sub(r"[\s\-‐‑‒–—]+", "", s)
    for k, v in WORD_NUM.items():
        if re.sub(r"[\s\-]+", "", k) == key:
            return v
    # 千分位：「430 000」「1,400」「12,5」（逗号后 3 位是千分位，否则是小数点）
    if re.fullmatch(r"\d+(?:[,\s]\d+)*(?:\.\d+)?", s):
        t = re.sub(r"\s+", "", s)
        if "," in t:
            a, _, b = t.partition(",")
            t = ("%s.%s" % (a, b)) if len(b) != 3 else a + b
        try:
            return float(t)
        except ValueError:
            return None
    # 分数式：「one-half」之外的写法 3-2 → 2.5
    m = re.fullmatch(r"(\d+)[-‐‑‒–—](\d+)", s)
    if m:
        try:
            return float(m.group(1)) + float(m.group(2)) / 2.0
        except ValueError:
            return None
    return None


def canon_value(value, unit):
    """换算到基准单位，跨写法可比。返回 (基准量纲, 数值) 或 None。"""
    if not unit:
        return None
    c = unit
    if c in BASE:
        dim, k = BASE[c]
        return (dim, value * k)
    return (c, value)


def _is_chinese_after(text, pos):
    return bool(re.match(r"\s*[一-鿿]", text[pos:pos + 3]))


# 只有**长度/面积**单位后面会跟脚注编号（「140 mm13」「10 cm 2」）。
# 字母单位（W/V/cd/lx/Hz）后面跟数字的是**标签**，不是脚注 ——
# 色度边界表里的「W1 0.310 0.348 W2 …」曾被读成「0.348 W」。
FOOTNOTE_UNITS = {"mm", "mm²", "cm", "cm²", "m", "m²"}


def scan_limits(text):
    """正文里的 (数值, 规范单位) —— 含公差项。

    「（90±30）次/min」会给出 (90, 次/min) 与 (30, 次/min) 两条。
    """
    clean = BROKEN_NUM.sub(".", re.sub(r"\s+", " ", text))
    out = []
    for m in VAL.finditer(clean):
        v = _parse_num(m.group("num"))
        if v is None:
            continue
        unit = ""
        for g in m.groupdict():
            if g in _UNIT_CANON and m.group(g) is not None:
                unit = _UNIT_CANON[g]
                break
        if not unit:
            continue
        tail = clean[m.end("uwrap"):]
        # 「2 V 级近光模式」里的 V 是**等级字母**，不是伏特；
        # 「13.5V」才是电压。判据：单位后面紧跟汉字就不是量值单位。
        if unit in ("V", "W") and _is_chinese_after(clean, m.end("uwrap")):
            continue
        # 「W1 0.310」里的 W 是色度边界编号，不是瓦特。
        if tail[:1].isdigit() and unit not in FOOTNOTE_UNITS:
            continue
        out.append((v, unit))
        # 公差项：矩阵里「90±30」是报成 90 和 30 两个数的，两条都要能被检到
        tol = re.search(r"(?:±|\+/-|\+-)\s*(\d+(?:\.\d+)?)", m.group(0))
        if tol:
            out.append((float(tol.group(1)), unit))
    return out


def scan_decimals(text):
    """正文里所有无单位的数（色度坐标、参考值、表格里的裸数值）。"""
    clean = BROKEN_NUM.sub(".", re.sub(r"\s+", " ", text))
    out = []
    for m in DECIMAL.finditer(clean):
        try:
            out.append(float(m.group(0)))
        except ValueError:
            pass
    for m in INTEGER.finditer(clean):
        try:
            out.append(float(m.group(0)))
        except ValueError:
            pass
    return out


def same_limit(v1, u1, v2, u2, tol=1e-9):
    """两个 (值, 单位) 是否是同一个限值（跨写法：m vs mm、° vs degree）。"""
    a = canon_value(v1, u1)
    b = canon_value(v2, u2)
    if a is None or b is None:
        return False
    if a[0] != b[0]:
        return False
    return abs(a[1] - b[1]) <= tol * max(1.0, abs(a[1]))
