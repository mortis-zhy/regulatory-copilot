# -*- coding: utf-8 -*-
"""阶梯第 3 级 · 第一步：从源文里自动**提议**参数（不直接进矩阵）。

背景
----
现在 27 个参数全是手写的 `data/parameter-specs.json`。手写的代价是覆盖率：
A 侧带「数字+单位」的候选有 242 句，矩阵只吃进 26 个，约 11%。

但候选池不能直接灌进矩阵 —— 打样就能看出五类噪声：

  条件放宽   「对于离地高度小于750mm的灯具，则水平面以下的垂直角可由10°减至5°」
             这是**例外**，不是基础要求。把它当参数报出去，等于告诉客户
             「制动灯垂直角上限 5°」，而基础要求是 10°。
  测量方法   「三次测量结果与其算术平均值的偏差不大于2mrad」
  定义/范围  「Axis of reference means the characteristic axis...」
  交叉引用   「测量方法参照4.8 b)」
  转引他标   「应符合 GB5920 中前示廓灯和后示廓灯的发光强度要求」

所以本脚本只做一件事：**把候选捞全、标好类别、交给人确认**，不自己下判断。
最终进矩阵的每一条都要人工写 `why`（见 .claude/skills/parameter-spec/SKILL.md）。

召回自检
--------
脚本会拿已有的 27 条 spec 去撞候选池：能撞上的说明抽取器没漏；
撞不上的要么是抽取器的问题，要么是该 spec 本来就不在候选形态里 ——
两种都打印出来，不藏。一个自称能做参数发现的脚本，说不出自己漏了什么，
那它的召回率就是个传说。
"""
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(os.environ.get("COMPARE_AGENT_ROOT", Path(__file__).resolve().parent.parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

MINERU = ROOT / "dist" / "mineru-v4-data.json"
SPECS = ROOT / "data" / "parameter-specs.json"
OUT = ROOT / "data" / "parameter-candidates.json"
VERSIONS = ["A", "B", "C"]

# --- 值的形态 -----------------------------------------------------------
# 源文写法比想象得杂，四种形态都得认，否则候选池漏掉的恰恰是最该报的那批：
#   1,200 mm / 1200㎜             常规
#   （90±30）次/min              单位在括号【后】面 —— 只认「数字紧跟单位」会整条丢掉
#   1s~1.5s / 1s～1.5s           区间
#   1.5s / 0.5 Hz                秒必须单列，否则「1.5s时间内首次熄灭」不成立
# 中文标准写「次/min」，R48 写 "times per minute"，两者都要认 ——
# 只认中文时 C 侧候选只有 23 条，等于把 147 页英文标准排除在外。
UNIT = (
    r"(?:㎜|mm|cm|km\s*/\s*h|cd\s*/\s*mm|cd\s*/\s*m2|cd|Hz|%|°|lx|mrad|kg|㎡|m2|nm"
    # NOT \b: Python's `\w` includes CJK, so `s\b` fails on "1.5s时间" — the
    # `s` and `时` are both word characters, so there is no boundary between
    # them. That silently dropped every seconds-valued clause in the corpus
    # (首次熄灭 1.5s, 点亮响应 1s, …) and pinned recall at 48/75.
    # `(?![A-Za-z])` is the boundary that actually means what we want: stop
    # before a longer latin word, allow any Chinese character after.
    r"|s(?![A-Za-z])|ms(?![A-Za-z])|min(?![A-Za-z])|V(?![A-Za-z])|mA(?![A-Za-z])|W(?![A-Za-z])"
    r"|次\s*/\s*(?:min|分)|times\s+per\s+minute|per\s+lamp|cd\s+per)"
)
_NUM = r"\d+(?:\.\d+)?"
# 数字与单位之间允许一个闭括号：「（90±30）次/min」
VALUE_RE = re.compile(rf"({_NUM}(?:\s*[±+/-]\s*{_NUM})?)\s*[)）]?\s*({UNIT})", re.I)
RANGE_RE = re.compile(rf"{_NUM}\s*[~～至]\s*{_NUM}\s*[)）]?\s*{UNIT}", re.I)
TOLERANCE_RE = re.compile(rf"{_NUM}\s*±\s*{_NUM}\s*[)）]?\s*{UNIT}", re.I)
# 色度多项式 y=0.150+0.640x 没有单位，四个色度参数全靠它才进得了候选池
POLY_RE = re.compile(r"[a-z]\s*=\s*\d*\.\d+\s*[-+]\s*\d*\.\d+\s*x", re.I)

# --- 条款号的形态 -------------------------------------------------------
# R48 写 "6.2.4.2."（带尾点），中文标准写 "5.2.4.2 高度"。尾点必须允许 ——
# 前瞻若排除它，整篇 C 会被判成「无条款」，275 个带单位候选只剩 23 个。
#
# 但「允许尾点」不等于「什么小数都能当条款」：`4.0-1.0 Hz`、`0.750x`、`1.5s`
# 里的 4.0 / 0.750 / 1.5 全都符合这个形状。区别在条款号后面跟的是空白、
# 中文或行尾，数值后面跟的是运算符或单位。
CLAUSE_ANY = re.compile(r"(?<![\d.])(\d+(?:\.\d+){1,4})\.?(?![\d])")
CLAUSE_TAIL_OK = re.compile(r"^\s*(?:$|[一-鿿A-Za-z（(])")

# --- 类别判定 -----------------------------------------------------------
# 顺序有意义：先判「不是要求」的，再判「是例外」的，剩下的才是基础要求。
# 必须双语 —— 见 UNIT 的注释。
RE_DEF = re.compile(
    r"是指|定义|称为|属于|本标准所称|"
    r"\bmeans\b|\bshall\s+mean\b|\bis\s+defined\b|\breferred\s+to\s+as\b"
)
RE_METHOD = re.compile(
    r"测量方法|测量结果|算术平均|重复测量|取其平均|测量值|试验方法|按附录\s*[A-Z]\s*规定"
    r"|\bmeasur\w*\b|\barithmetic\s+mean\b|\btest\w*\s+method\b|\bmeasuring\s+method\b"
)
RE_XREF = re.compile(
    r"参见|参照\s*\d|见\s*\d+\.\d+|符合\s*GB|按\s*GB\s*\d"
    r"|\bin\s+accordance\s+with\b|\bsee\s+also\b|\bconforming\s+to\s+GB\b"
)
# 「值被替换的例外」—— 这些不是参数。
#
# 关键区分：开头带「若/对于/当」并不能判定为例外。
#   「当车辆前行速度大于15km/h时，慢行灯应自动熄灭」 → 阈值本身就是参数
#   「对于离地高度小于750mm的灯具，垂直角可由10°减至5°」 → 值被替换掉了
# 只有句中出现**替换动词**（减至/增至/可由…减至）时，才是后一种。
# 早期版本把「以若/对于/当起头」一律当例外，把 A 侧慢行灯车速阈值整个排除，
# 召回率因此卡在 48/75。
RE_RELAX = re.compile(
    r"减至|增至|放宽|可由|可增至|可减小|例外|特殊情况下|不适用本条"
    r"|\brelaxed\b|\bmay\s+be\s+(?:in)?creased\b|\bexcept\b|\bprovided\s+that\b"
)
# 车辆类别 / 位置限定（「对于S3或S4类制动灯」「N2G、N3G类车辆」）是适用范围，不是例外。
#
# 条件是"以限定词开头"【且】"句中真的出现范围名词"。早期版本只查开头，
# 于是「在1.5s时间内首次熄灭」被当成范围限定 —— 它只是以「在」开头而已。
RE_SCOPED_LEAD = re.compile(r"^[（(\s]*(若|对于|在|当|如果|如)")
RE_SCOPE_NOUN = re.compile(r"类|车型|车辆组|车辆类别|位置|侧面|后面|越野|挂车|货车|客车")
RE_NOTAPPL = re.compile(
    r"不适用|本条不适用|应符合\s*GB\s*\d{4,5}|由\s*GB\s*\d{4,5}|\bnot\s+(?:be\s+)?applicable\b"
)


def paginate(doc: dict):
    """MinerU fullText → [(page, text)]，按它自己的 [第N页] 标记切。"""
    parts = re.split(r"\[第(\d+)页\]", str(doc.get("fullText", "")))
    out = []
    for i in range(1, len(parts), 2):
        n = int(parts[i])
        if n:
            out.append((n, parts[i + 1] if i + 1 < len(parts) else ""))
    return out


def nearest_clause(text: str, idx: int) -> str:
    """Nearest PRECEDING clause number, never a value that merely looks like one.

    `0.750` is a chromaticity value and `5.2.4.2` is a clause; `4.0-1.0 Hz` is a
    frequency range and not clause 4.0. Two filters separate them: a leading zero
    disqualifies (the rule parameterMatrix.ts uses for the same reason), and the
    text right after the number must be whitespace / CJK / end rather than an
    operator or a unit.
    """
    last = ""
    for m in CLAUSE_ANY.finditer(text):
        if m.start() >= idx:
            break
        if m.group(1).startswith("0."):
            continue
        tail = text[m.end() : m.end() + 6]
        if tail and not CLAUSE_TAIL_OK.match(tail):
            continue
        last = m.group(1)
    return last


def classify(sent: str):
    """(category, reasons). The order is load-bearing — see the module docstring."""
    if RE_DEF.search(sent):
        return "定义/范围", ["含定义句式"]
    if RE_METHOD.search(sent):
        return "测量方法", ["含测量方法句式"]
    if RE_NOTAPPL.search(sent):
        return "转引他标", ["指向别的 GB 标准而非本标准限值"]
    if RE_XREF.search(sent):
        return "交叉引用", ["只引用别处"]
    if RE_RELAX.search(sent):
        return "条件放宽", ["值被替换的例外条款，非基础要求"]
    if RE_SCOPED_LEAD.match(sent) and RE_SCOPE_NOUN.search(sent):
        return "适用范围限定", ["按车辆类别/位置限定，非通用限值"]
    return "基础要求", []


def unit_of(sent: str) -> str:
    u = VALUE_RE.search(sent)
    return u.group(2).replace(" ", "") if u else ""


def numbers_in(sent: str):
    """The value numbers, tolerance and range endpoints folded in.

    `90±30 次/min` yields 90 and 30; `1s~1.5s` yields 1 and 1.5. Both are what
    the reader needs — reporting only the nominal of a tolerance is how a
    report ends up claiming A requires 90 次/min when it allows 60–120.
    """
    seen, out = set(), []
    for pat in (VALUE_RE, RANGE_RE, TOLERANCE_RE):
        for m in pat.finditer(sent):
            for v in re.findall(r"\d+(?:\.\d+)?", m.group(0)):
                if v not in seen:
                    seen.add(v)
                    out.append(v)
    return out


def is_section_break(line: str) -> bool:
    """Front/back matter that must CLEAR the current lamp.

    牌照灯 is the last lamp in GB 4785; everything after it (附录 A/B/C, the
    photometry tables, the change list) is not about 牌照灯. Without a reset
    there, one heading swallowed 68 candidates — worse than having no topic at
    all, because the rows look confident.
    """
    t = line.strip()
    return bool(re.match(r"^(附录|前言|目次|引言|范围|规范性引用|本标准适用|修改单|勘误)", t)) and len(t) < 40


def is_lamp_heading(line: str) -> bool:
    """A standalone short CJK line is a lamp/section name: 倒车灯, 制动灯, 示廓灯…

    GB 4785 prints the lamp name on its own line immediately before its clause
    block ("倒车灯\\n5.21.1 配备\\n…5.21.4.2 高度:…"), which is the only place
    the document says *which lamp* a clause belongs to. Without it, every
    "离地高度不小于 Xmm" in the standard lands in one bucket — 22 candidates
    for 12 different lamps — and the grouping below cannot tell 倒车灯's limit
    from 前位灯's.
    """
    t = line.strip()
    if not (2 <= len(t) <= 12):
        return False
    if not re.fullmatch(r"[一-鿿/／()（）\s]+", t) or t.startswith("第"):
        return False
    # Standalone short CJK lines that are not lamps: "单位为毫米", "选装",
    # "路试". Treating them as topics splits one lamp's clauses across buckets
    # under a meaningless name.
    return not re.search(r"单位|选装|路试|试验|附录|参见|注[：:]|表\s*\d", t)


# Requirement kind — what is being limited, independent of the lamp. Together
# with the lamp name this is the row key: (倒车灯, 高度) is one matrix row.
KINDS = [
    ("离地高度", r"离地高度|高度[:：]"),
    ("垂直角", r"垂直方向角|垂直角|向上角度|向下角度"),
    ("水平角", r"水平方向角|水平角|向外角度|向内角度"),
    ("角度", r"方向角|角度"),
    ("频率", r"闪烁频率|闪光频率|频率"),
    ("时间", r"时间|熄灭|点亮响应"),
    ("光强", r"发光强度|最大光强|光强"),
    ("照度", r"照度|环境光"),
    ("色度", r"边界|色度|光谱轨迹"),
    ("电压", r"电压"),
    ("间距", r"间距|间隔|相邻"),
    ("横向位置", r"横向"),
]


def requirement_kind(sent: str) -> str:
    for kind, pat in KINDS:
        if re.search(pat, sent):
            return kind
    return "其他"


def extract(data: dict):
    cands = []
    for ver in VERSIONS:
        # Carried ACROSS pages on purpose. The lamp name sits at the very end of
        # one page and its clauses start on the next: the source reads
        # "…按GB 11564要求。<NL>倒车灯<NL>5.21.1 配备<NL>53<NL>[第58页]<NL>
        #  GB 4785—XXXX<NL>汽车和O2、O3…". Resetting `topic` per page left
        # 513 of 593 candidates with no lamp at all.
        topic = ""
        topic_prefix = ""
        for page, text in paginate(data.get(ver, {})):
            for sent in re.split(r"(?<=[。；;\n])", text):
                s = sent.strip()
                if not s:
                    continue
                if is_lamp_heading(s):
                    topic = s
                    topic_prefix = ""  # armed by the first clause that follows
                    continue
                if is_section_break(s):
                    topic = ""
                    topic_prefix = ""
                    continue
                if not (12 <= len(s) <= 260):
                    continue
                vals = numbers_in(s)
                if not vals and not POLY_RE.search(s):
                    continue
                clause = nearest_clause(text, text.find(s) if s in text else 0)
                if not clause:
                    # Nothing to anchor on: nobody could re-find this later, so
                    # it cannot become a row.
                    continue
                cat, why = classify(s)
                # Lamp sections are numbered contiguously, so a clause whose
                # top-level prefix leaves the section the heading opened is not
                # that lamp's clause. Scoping the topic this way is what keeps
                # 牌照灯 — the last lamp in the standard — from claiming 68
                # candidates spread over 46 pages, including 3.3 (general
                # definitions) and 5.25 (slow-moving lamps).
                if topic and not topic_prefix:
                    topic_prefix = ".".join(clause.split(".")[:2])
                eff_topic = topic if topic and clause.startswith(topic_prefix) else ""
                cands.append(
                    {
                        "version": ver,
                        "topic": eff_topic,
                        "kind": requirement_kind(s),
                        "page": page,
                        "clause": clause,
                        "unit": unit_of(s),
                        "numbers": vals,
                        "category": cat,
                        "reasons": why,
                        "sentence": re.sub(r"\s+", " ", s),
                    }
                )
    return cands


def key_tokens(sent: str):
    """Content tokens used to decide whether two sentences state the SAME rule.

    Clause numbers are deliberately excluded: A's 5.7.5.1 and B's 5.7.5.1 are
    different requirements, so they cannot be the join key. That mistake is the
    Presence-clause bug from the skill's pitfall 1, one level up.
    """
    s = re.sub(r"[（(]\s*\d+(\.\d+)*\s*[)）]", " ", sent)
    return set(re.findall(r"[一-鿿]{2,}", s)) | set(re.findall(r"[A-Za-z]{3,}", s))


def similarity(a, b) -> float:
    """Overlap relative to the SMALLER token set, not Jaccard.

    Cross-version comparison is exactly the paraphrase problem: "车辆向前行驶速度超过"
    vs "车辆前行速度大于" share 2 of 7 tokens — Jaccard 0.29, which is the worst
    possible way to score two sentences that mean the same clause. Scoring against
    the smaller set asks the question we actually care about: is the shorter
    sentence's vocabulary covered by the longer one?
    """
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def group(cands):
    """Bucket sentences that state one requirement across versions.

    The key is (lamp, kind) — 倒车灯 × 离地高度 — not the sentence text.

    Text similarity alone was tried first and fails in the way that matters:
    all 22 "离地高度不小于 Xmm，不大于 Ymm" sentences across 12 lamps score
    ~1.0 against each other, so they collapse into one bucket and the group no
    longer says which lamp a number belongs to. That is pitfall 1 of the skill
    one level up: joining on what the text looks like instead of on what it is
    about. The lamp name comes from the standalone heading line; the kind comes
    from a closed vocabulary.

    Candidates whose lamp heading was not detected keep the text-similarity key
    and are tagged so a reviewer knows the grouping there is weaker.
    """
    buckets = defaultdict(list)
    weak = []
    for c in cands:
        if c["topic"] and c["kind"] != "其他":
            buckets[(c["topic"], c["kind"])].append(c)
        else:
            weak.append(c)

    out = list(buckets.items())

    # Candidates whose lamp heading was not detected have no strong key. Cluster
    # those by text similarity instead, and mark them so a reviewer knows the
    # grouping there is a guess.
    wbuckets, order = defaultdict(list), []
    for c in weak:
        tk = frozenset(key_tokens(c["sentence"]))
        for k in order:
            if similarity(tk, k) >= 0.5:
                wbuckets[k].append(c)
                break
        else:
            wbuckets[tk].append(c)
            order.append(tk)
    out += [(("~未定位灯具~", k), wbuckets[k]) for k in order]
    return out


def main() -> None:
    data = json.load(io.open(MINERU, encoding="utf-8"))
    cands = extract(data)

    groups = []
    for _, members in group(cands):
        vers = {m["version"] for m in members}
        if not vers:
            continue
        # One-sided groups are KEPT and labelled. The old filter dropped them
        # on the theory that "only one version has it" means it is a wording
        # change rather than a parameter — which is true for wording and false
        # for a limit. Measured: all 14 `cd` candidates died here, and 光强 is
        # the thinnest family in the matrix (6 of 71). A 国标-only 光强限值 is
        # exactly what the client is asking about, and the matrix already
        # supports `${key}-only` verdicts (8 c-only, 1 a-only today).
        base = [m for m in members if m["category"] == "基础要求"]
        if not base:
            # Every member is an exemption / definition / method. Keep it in the
            # output anyway: a reviewer may know better than the classifier,
            # and silently dropping it is how coverage quietly stops growing.
            groups.append({
                "versions": sorted(vers),
                "category": ("仅 %s 版规定（单边证据，需人工确认该版是否真的新增）"
                             % "/".join(sorted(vers)) if len(vers) == 1
                             else "全为非基础要求（需人工判断）"),
                "candidates": [
                    {k: m[k] for k in ("version", "topic", "kind", "page", "clause", "unit", "numbers", "sentence")}
                    for m in sorted(members, key=lambda x: VERSIONS.index(x["version"]))
                ],
                "alsoSeen": [],
            })
            continue
        groups.append(
            {
                "versions": sorted(vers),
                "candidates": [
                    {
                        k: m[k]
                        for k in ("version", "topic", "kind", "page", "clause", "unit", "numbers", "sentence")
                    }
                    for m in sorted(base, key=lambda x: VERSIONS.index(x["version"]))
                ],
                "alsoSeen": [
                    {k: m[k] for k in ("version", "page", "clause", "category", "sentence")}
                    for m in members
                    if m["category"] != "基础要求"
                ],
            }
        )

    counts = Counter(c["category"] for c in cands)
    print("候选池：%d 条（按版本 %s）" % (
        len(cands), dict(Counter(c["version"] for c in cands))))
    for cat, n in counts.most_common():
        print("  %-10s %4d" % (cat, n))
    print("跨版本成组（>=2 版、且含基础要求）：%d 组" % len(groups))

    # --- recall self-check against the hand-written specs ------------------
    specs = json.load(io.open(SPECS, encoding="utf-8"))
    anchors = []
    for s in specs["specs"]:
        for v, pat in (s.get("patterns") or {}).items():
            m = re.search(r"[一-鿿]{4,}", pat.get("source", "") or "")
            anchors.append((s["id"], v, set(re.findall(r"[一-鿿]{2,}", m.group(0))) if m else set()))

    recalled, missed = 0, []
    for sid, ver, tk in anchors:
        hit = False
        for g in groups:
            for c in g["candidates"]:
                if c["version"] != ver:
                    continue
                if not tk or len(tk & key_tokens(c["sentence"])) / len(tk) >= 0.5:
                    hit = True
                    break
            if hit:
                break
        if hit:
            recalled += 1
        else:
            missed.append("%s/%s" % (sid, ver))
    print("召回自检：%d/%d 条已有 spec 的取值锚点能在候选池里找到" % (recalled, len(anchors)))
    if missed:
        print("  未召回（抽取器漏，或该 spec 本就不在候选形态里）:")
        for m in missed:
            print("    -", m)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(
        json.dumps(
            {
                "generated": "scripts/propose_parameters.py",
                "note": (
                    "自动提议，未确认。进 parameter-specs.json 前每条都要人工写 why —— "
                    "见 .claude/skills/parameter-spec/SKILL.md 的七个坑。"
                ),
                "candidateCount": len(cands),
                "byCategory": dict(counts),
                "groupCount": len(groups),
                "recall": "%d/%d" % (recalled, len(anchors)),
                "groups": groups,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print("→ %s" % OUT.name)


if __name__ == "__main__":
    main()