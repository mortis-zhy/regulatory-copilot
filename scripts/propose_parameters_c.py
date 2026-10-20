# -*- coding: utf-8 -*-
"""阶梯第 3 级 · C 列（UN R48）专用提议器。

问题
----
矩阵 71 行里 C 列只有 34 行有值。不是因为 R48 没规定，而是**两套标准的
条款体系对不上**：

    GB 4785   5.18.4.2 高度:…          ← 条款号在 A/B/C 三版之间全部重排
    UN R48    6.18.4.2. In height:…     ← 另起一套编号，且按灯具分章

所以「补一条 C 的正则」不是往现有 spec 里加一行 —— 它需要**先知道这个参数
属于 R48 的哪一盏灯**，再在该章里按条款类型（位置 / 几何可见度 / …）去找。
这正是 SKILL 坑 1 的放大版：不按条款锚定就会落到 Presence / Number 样板。

做法
----
1. `R48_SECTIONS` 是声明式的「R48 章节 → 灯」表（和 `VERSION_META` 同一个
   取舍：显示名与归属是领域知识，推不出来，只能写明）。
2. 启动时**逐条校验**这张表在语料里真的存在，缺一条就抛错 —— 一张对不上的
   映射表比没有更糟。
3. 在该章里找带数值单位的句子，按 (需求种类, 数值) 排序。
4. **自动生成正则**：取句首一段有区分度的英文原文作字面锚，值单独用捕获组框住。
5. 输出待确认清单，**不直接改 spec** —— 交给 `web/参数提议确认.html` 人工裁定。

为什么「数值与 A/B 不重合」不再算拒绝理由
------------------------------------------
初版把"数值与 A/B 重合"当作置信信号，不重合就报 `no-value-match` 丢弃。
这是**假阴性**：GB 与 R48 在「制动灯间距」「侧转向灯距车头」这类项上本就
取值不同（GB 600/400 vs R48 600/400，或 GB 1800 vs R48 1800 但表述层级不同），
而"不同"恰恰是要摆到客户面前的东西。真正要挡的是**抓到错误的条款**，
那由条款号 + 原文摘录人工比对，不该由数值相等来代理。

因此本版**永远返回候选句**（带条款号、页码、取值），把裁定留给确认页。
宁可多列十条让人排除，不可自动丢一条。

生成的正则一律满足两条硬约束（否则历史上都出过事）：
- 锚点与值**同页**：跨不了 [第N页] 标记，所以锚点取句子自己的前半段
- 捕获组只框**值**：车型编号、交叉引用都不该进 `nums`
"""
import io
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(os.environ.get("COMPARE_AGENT_ROOT", Path(__file__).resolve().parent.parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

MINERU = ROOT / "dist" / "mineru-v4-data.json"
SPECS = ROOT / "data" / "parameter-specs.json"
REPORT = ROOT / "reports" / "last-report.json"
OUT = ROOT / "data" / "parameter-candidates-c.json"

# --- R48 章节 → 灯 --------------------------------------------------------
# (章节号, 英文名, 名称探针, GB 侧关键词)
#
# 三处都是**声明式的领域知识**，推不出来，只能写明 —— 和 `VERSION_META` 同一个
# 取舍。写错的后果很具体：本表曾把 6.14 标成「Direction-indicator position」，
# 而 6.14 实为 Rear retro-reflector，导致所有「侧转向灯」行被派到错误的章，
# 候选句全是回复反射器的条文。所以下面每条都带一个**名称探针**，
# `verify_map()` 会去原文里验它 —— 映射表对不上语料必须当场炸掉。
#
# 章节表按**文档出现顺序**参与区间切分，不是按编号排序：6.14 排在 6.15 之前，
# 而初版 `sorted(key=int)` 会把 6.14 排到最后，于是 6.25 的区间一路吞到文末，
# 6.14 的区间吞掉整个 6.15。
R48_SECTIONS = [
    ("6.2", "Dipped-beam headlamp", "dipped-beam headlamp", ["近光", "dipped"]),
    ("6.3", "Front fog lamp", "front fog lamp", ["前雾"]),
    ("6.4", "Reversing lamp", "reversing lamp", ["倒车"]),
    ("6.5", "Direction-indicator lamp", "direction-indicator lamp", ["转向"]),
    ("6.6", "Hazard warning signal", "hazard warning signal", ["危险警告"]),
    ("6.7", "Stop lamp", "stop lamp", ["制动灯", "高位制动"]),
    ("6.8", "Rear registration plate lamp", "registration plate", ["牌照"]),
    ("6.9", "Front position lamp", "front position lamp", ["前位灯"]),
    ("6.10", "Rear position lamp", "rear position lamp", ["后位灯"]),
    ("6.11", "Rear fog lamp", "rear fog lamp", ["后雾"]),
    ("6.12", "Parking lamp", "parking lamp", ["停车灯"]),
    ("6.13", "End-outline marker lamp", "end-outline marker", ["示廓"]),
    ("6.14", "Rear retro-reflector, non-triangular", "retro-reflector", ["后回复反射器"]),
    ("6.15", "Rear retro-reflector, triangular", "retro-reflector", ["三角形回复反射器"]),
    ("6.16", "Front retro-reflector, non-triangular", "retro-reflector", ["前回复反射器"]),
    ("6.17", "Side retro-reflector, non-triangular", "retro-reflector", ["侧回复反射器"]),
    ("6.18", "Side-marker lamps", "side-marker", ["侧标志灯"]),
    ("6.19", "Daytime running lamp", "daytime running lamp", ["昼间行驶"]),
    ("6.20", "Cornering lamp", "cornering lamp", ["角灯"]),
    ("6.21", "Conspicuity markings", "conspicuity", ["反光标识"]),
    ("6.22", "Adaptive front lighting system", "adaptive front lighting", ["自适应"]),
    ("6.23", "Emergency stop signal", "emergency stop signal", ["紧急制动"]),
    ("6.24", "Exterior courtesy lamp", "courtesy", ["门灯", "礼貌灯"]),
    ("6.25", "Rear-end collision alert signal", "rear-end collision", ["追尾警告"]),
    ("6.26", "Manoeuvring lamps", "manoeuvring", ["辅助转向灯"]),
]

# 需求种类关键词 → 匹配用的关键词（R48 是英文）
# 顺序即优先级：`kind_of()` 先按 spec 名里的中文判定，再退化到 family 里的族名。
KIND_EN = {
    "车速": ["km/h", "speed", "reversing", "stationary"],
    "离地高度": ["above the ground", "height"],
    "安装高度": ["above the ground", "height"],
    "垂直角": ["upward angle", "downward angle", "vertical angle"],
    "水平角": ["horizontal angle", "inward angle", "outward angle"],
    "角度": ["angle", "downward", "upward"],
    "间距": ["distance between", "apart", "not less than", "separation"],
    "横向位置": ["Position In width", "from the extreme outer edge", "median longitudinal plane"],
    "位置": ["In width", "In length", "In height", "Position"],
    "频率": ["flashing", "frequency", "times per minute"],
    "时间": ["seconds", "extinction", "within"],
    "光强": ["cd", "maximum luminous intensity", "minimum luminous intensity"],
    "照度": ["lx", "illuminance"],
    "电压": ["V(", "voltage"],
    "色度": ["boundary", "chromaticity"],
}

VALUE_UNIT = r"(?:mm|cd|cd/mm2|°|lx|Hz|V|m|km/s|km\s*/\s*h|s\b|nm|mrad)"

# 每行最多列几条候选。人看十条会烦，看三条会漏；取 6 是折中，
# 确认页默认只展开前 3 条。
MAX_CANDIDATES = 6


def paginate(doc):
    parts = re.split(r"\[第(\d+)页\]", str(doc.get("fullText", "")))
    out = []
    for i in range(1, len(parts), 2):
        out.append((int(parts[i]), parts[i + 1] if i + 1 < len(parts) else ""))
    return out


def _section_head(no):
    r"""Regex for a §6.x HEADING at line start — not a sub-clause.

    Two traps, both hit for real:

    1. `^6.13\.` also matches the sub-clause `6.13.4.1. In width:`, and
       `re.search` returns the FIRST hit in the document, so §6.13's span
       began at §6.13.4.1 — hundreds of characters into the section. The
       opening probe check caught it. A real heading reads `6.13.` + SPACE +
       title (`6.21. Conspicuity markings`); a sub-clause reads `6.13.2.` +
       space, i.e. a digit after the dot. `(?!\d)` also stops §6.2 from
       matching the line `6.20. Cornering lamp`.
    2. Anchoring on the space alone drops the merged form `6.14.6.14.1.`,
       which silently removed §6.14 and §6.25 from the map entirely.
    """
    n = re.escape(no)
    return r"(?m)^[|\s]*%s(?!\d)(?:\.\s|\.(?=%s)|\s|$)" % (n, n)


def r48_section_spans(full_text):
    """(start, end) char offsets for each declared R48 §6.x section.

    Ordered by **document position**, never by section number: §6.14 sits
    before §6.15 in the text, so a numeric sort would hand §6.25 the rest of
    the document and let §6.14 swallow all of §6.15.
    """
    spans = {}
    marks = []
    for idx, (no, _name, _probe, _kw) in enumerate(R48_SECTIONS):
        m = re.search(_section_head(no), full_text)
        if m:
            marks.append((m.start(), idx))
    marks.sort()
    for pos, (start, idx) in enumerate(marks):
        no = R48_SECTIONS[idx][0]
        end = marks[pos + 1][0] if pos + 1 < len(marks) else len(full_text)
        spans[no] = (start, end)
    return spans


def verify_map(spans, full_text):
    """A map that does not match the corpus is worse than no map.

    Two checks, not one. Existence was the original check and it was not
    enough: §6.14 exists, so a wrong *name* for it sailed through and every
    侧转向灯 row got pointed at the retro-reflector clauses. The probe check
    below is what catches that class — the same self-verification idea as
    `VERSION_META`, where declared display names are checked against the corpus.
    """
    missing = []
    misnamed = []
    for no, name, probe, _kw in R48_SECTIONS:
        if no not in spans:
            missing.append("%s %s" % (no, name))
            continue
        start, end = spans[no]
        # The heading itself is merged into the first table row by MinerU, so
        # the probe is searched over the section's opening 1,200 chars.
        head = full_text[start : start + 1200].lower()
        if probe.lower() not in head:
            misnamed.append("%s 声明为「%s」，原文开头 %d 字里找不到探针「%s」" % (no, name, 1200, probe))
    if missing:
        raise SystemExit(
            "R48_SECTIONS 与语料不符，缺失 %d 条: %s\n"
            "—— 映射表必须逐条在原文里验到，否则后面生成的正则全是错的" % (len(missing), ", ".join(missing))
        )
    if misnamed:
        raise SystemExit(
            "R48_SECTIONS 章节名与语料不符 %d 条:\n  %s\n"
            "—— 章节号对而名称错，比缺一条更危险：候选句会静默地全部指向错误的章。"
            % (len(misnamed), "\n  ".join(misnamed))
        )
    return len(spans)


def pick_section(spec):
    """Which R48 section does this spec belong to, by keyword on name/family.

    Longer keywords first: `转向` would otherwise swallow 侧转向灯 into 6.5
    before 6.14's own keywords get a look — and the two chapters state
    different width rules.
    """
    hay = (spec.get("name", "") + " " + spec.get("family", "")) + " " + spec["id"]
    pairs = []
    for no, _name, _probe, kws in R48_SECTIONS:
        for k in kws:
            if k.lower() in hay.lower():
                pairs.append((len(k), no))
    if not pairs:
        return None
    pairs.sort(reverse=True)
    return pairs[0][1]


def kind_of(spec):
    """Which requirement kind this row is — from the NAME, not only the family.

    The family is too coarse: every angular row says "几何可见度 / 安装角度",
    which degenerates to the bare keyword "angle" and then matches
    `Vertical angle: 10° above and below` for a row that is asking about the
    *inward* angle. The two happen to share the value 10, so the number matched
    and the meaning did not — the exact failure mode this whole module exists
    to prevent, reproduced by the tool that was supposed to prevent it.
    """
    name = spec.get("name", "")
    if "车速" in name:
        return "车速"
    if "水平" in name:
        return "水平角"
    if "垂直" in name:
        return "垂直角"
    if "角度" in name or "可见角" in name or "可见度角" in name:
        return "角度"
    f = spec.get("family", "")
    for kind in KIND_EN:
        if kind.replace(" ", "") in f.replace(" ", ""):
            return kind
    if "车速" in f:
        return "车速"
    if "高度" in f or "离地" in f:
        return "离地高度"
    if "角" in f:
        return "角度"
    return None


def values_in(sent):
    return [m.group(1) for m in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:%s)" % VALUE_UNIT, sent)]


def clause_at(body, offset):
    """Nearest R48 clause number at or before `offset` — `6.5.4.1.` style.

    MinerU merged some section headings into the first clause, so the raw text
    reads `6.14.4.6.14.4.1.` — clause, then the section heading, then the real
    clause again. Taking the longest match yields `6.14.4.6.14`, a number that
    does not exist. Collapse the repeat and keep the tail.
    """
    window = body[:offset]
    best = ""
    # Line-anchored only. A bare scan picks up cross-references — "in
    # accordance with paragraph 5.11" — and §6.4's switching-off rule was
    # being labelled 5.11 because that cross-reference was the last
    # `d+.d+` token before it. R48 writes every clause number at a line start.
    for m in re.finditer(r"(?m)^[|\s]*(\d+\.\d+(?:\.\d+){0,3})\.?(?![\d])", window):
        best = m.group(1)
    parts = best.split(".")
    for cut in range(1, len(parts)):
        head, tail = parts[:cut], parts[cut:]
        if len(head) >= 2 and head[:2] == tail[:2]:
            return ".".join(tail)
    return best


def sentence_anchor(sent, target_value, words_back=7):
    """A literal prefix of the sentence, tolerant of line wrapping.

    Word-by-word escaping then joined with `\\s+`, because MinerU hard-wraps
    English text and a literal space matches nowhere. Two competing demands:
    distinctive enough not to match a neighbouring clause, short enough that
    the value stays on the same page (a pattern cannot span a [第N页] marker).
    """
    s = re.sub(r"\s+", " ", sent).strip()
    i = s.find(target_value)
    if i < 0:
        return None
    prefix = s[:i].strip().rstrip(".,;:")
    words = prefix.split(" ")
    tail = words[-words_back:] if len(words) > words_back else prefix
    if not tail:
        return None
    return r"\s+".join(re.escape(w) for w in tail if w)


def scan(section_no, spans, page_of, full_text, kind, ab_vals):
    """Every kind-matching numeric sentence in one R48 section, ranked.

    Ranking is advisory, not a filter. `overlap` (does the value equal what
    A/B says) breaks ties; `clause` depth breaks the rest. The confirmation
    page shows them all and a human picks — see the module docstring.
    """
    start, end = spans[section_no]
    body = full_text[start:end]
    kws = KIND_EN[kind]
    hits = []
    # Split on sentence end AND newlines: MinerU wraps mid-sentence, so a
    # value and its keyword can land on different physical lines.
    for m in re.finditer(r"[^\n.;]{20,300}", body):
        raw = m.group(0)
        s = re.sub(r"\s+", " ", raw).strip()
        if not (25 <= len(s) <= 260):
            continue
        hits_any = [k for k in kws if k.lower() in s.lower()]
        if not hits_any:
            continue
        vals = values_in(s)
        if not vals:
            continue
        cl = clause_at(body, m.start())
        overlap = [v for v in vals if v in ab_vals]
        hits.append(
            {
                "clause": cl,
                "sentence": s,
                "values": vals,
                "overlap": overlap,
                "keywords": hits_any[:3],
                "page": page_of(start + m.start()),
            }
        )
    hits.sort(key=lambda h: (-len(h["overlap"]), -len(h["clause"]), len(h["sentence"])))
    return hits[:MAX_CANDIDATES]


def page_of(full_text):
    """char offset → MinerU page number (the `[第N页]` markers, not the PDF's)."""
    marks = [(m.end(), int(m.group(1))) for m in re.finditer(r"\[第(\d+)页\]", full_text)]

    def f(off):
        p = 1
        for end, n in marks:
            if end <= off:
                p = n
            else:
                break
        return p

    return f


def propose(spec, cells, spans, full_text, pg):
    no = pick_section(spec)
    kind = kind_of(spec)
    ab_vals = {v for lb in ("A", "B") for v in (cells.get(lb) or {}).get("nums", [])}

    res = {"id": spec["id"], "name": spec["name"], "family": spec.get("family", "")}
    res["abValues"] = sorted(ab_vals)
    res["section"] = no
    res["sectionName"] = next((n for x, n, _pr, _ in R48_SECTIONS if x == no), None)
    res["kind"] = kind
    res["sectionOptions"] = [{"no": x, "name": n} for x, n, _pr, _k in R48_SECTIONS]

    if no is None or kind is None:
        # Either the GB row has no obvious R48 home (a GB-only clause such as
        # 驾驶员辅助投射) or its requirement kind is new. Both are legitimate
        # "a human must look" states -- so scan every section rather than bail,
        # and let the page filter. Scanning all 21 sections for all rows is
        # cheap and turns "I don't know where this lives" into "here are six
        # sentences, pick one".
        pool = []
        for other, _n, _pr, _k in R48_SECTIONS:
            if other == no:
                continue
            pool += scan(other, spans, pg, full_text, kind, ab_vals) if kind else []
        pool.sort(key=lambda h: (-len(h["overlap"]), -len(h["clause"])))
        res["candidates"] = pool[:MAX_CANDIDATES]
        res["status"] = "needs-placement"
        res["reason"] = (
            "未能按名称/族归到任何 R48 章节" if no is None else "未能判定需求种类"
        ) + " —— 下方候选句来自全部章节，请人工指认"
        return res

    cands = scan(no, spans, pg, full_text, kind, ab_vals)
    res["candidates"] = cands
    if cands:
        res["status"] = "candidates"
        res["reason"] = "%s 章里找到 %d 条含%s关键词的数值句" % (no, len(cands), kind)
    else:
        res["status"] = "no-hit"
        res["reason"] = "%s 章里没有含%s关键词的数值句" % (no, kind)
    return res


def main():
    data = json.load(io.open(MINERU, encoding="utf-8"))
    full_text = str(data.get("C", {}).get("fullText", ""))
    spans = r48_section_spans(full_text)
    n = verify_map(spans, full_text)
    pg = page_of(full_text)
    print("R48 章节映射校验通过：%d/%d 条在原文里验到" % (n, len(R48_SECTIONS)))

    specs = json.load(io.open(SPECS, encoding="utf-8"))["specs"]
    rows = {}
    if REPORT.exists():
        for r in json.load(io.open(REPORT, encoding="utf-8")).get("parameterMatrix", []):
            rows[r["id"]] = r.get("cells", {})

    out = []
    counts = defaultdict(int)
    for s in specs:
        cells = rows.get(s["id"], {})
        if "C" in (s.get("patterns") or {}):
            counts["已有 C"] += 1
            continue
        res = propose(s, cells, spans, full_text, pg)
        counts[res["status"]] += 1
        counts["候选句 %d" % min(len(res["candidates"]), 9)] += 1 if res["candidates"] else 0
        out.append(res)

    print("已有 C 模式 %d 条；待裁定 %d 条" % (counts["已有 C"], len(out)))
    for k in ("candidates", "no-hit", "needs-placement"):
        print("  %-14s %d" % (k, counts[k]))
    withcand = sum(1 for r in out if r["candidates"])
    print("  候选句非空    %d / %d" % (withcand, len(out)))
    print()
    for r in out:
        print("── %s  [%s / %s]  A/B=%s" % (r["name"], r["section"] or "?", r["kind"] or "?", "/".join(r["abValues"][:4])))
        if not r["candidates"]:
            print("     （无候选：%s）" % r["reason"])
        for c in r["candidates"][:3]:
            mark = "★" if c["overlap"] else " "
            print("   %s %-9s p%-4s %s" % (mark, c["clause"] or "?", c["page"], c["sentence"][:120]))

    io.open(OUT, "w", encoding="utf-8").write(
        json.dumps(
            {
                "generated": "scripts/propose_parameters_c.py",
                "note": (
                    "C 列候选清单，未确认。**每条都要回 R48 原文核对条款号后再写进 "
                    "data/parameter-specs.json**；★ 只表示取值与 A/B 有重合，"
                    "不表示抓对了条款 —— 那正是 SKILL 坑 1。"
                    "打开 web/参数提议确认.html 逐条裁定。"
                ),
                "r48SectionsVerified": n,
                "sections": [{"no": x, "name": nm} for x, nm, _pr, _ in R48_SECTIONS],
                "statusCounts": {k: v for k, v in counts.items() if not k.startswith("候选句")},
                "rows": out,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print("→ %s" % OUT.name)


if __name__ == "__main__":
    main()
