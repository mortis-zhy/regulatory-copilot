# -*- coding: utf-8 -*-
"""**装置↔章映射** —— 解开「章号自指」这个死结。

## 为什么要有这个文件

取值规格提议 agent（`server/reports/specAgent.ts`）要干活，先得知道
「这个装置住在哪一章」—— 候选句是从**章里**捞的。

而它现在怎么知道的？**从现有手写 spec 的正则里反推**
（`deviceChapterPrefixes()`：把同一 id 前缀的兄弟 spec 的条款锚点前两段投票取多数）。

于是换一套标准时：

```
没有手写 spec → 推不出章号 → 候选为空 → agent 跑不起来 → 还是得手写 spec
```

**这是整个 agent-native 的死结**，而且它是**确定性的**问题，不是模型的问题。

## 这一层干什么

它把「哪一章住着哪个装置」变成**一等公民数据**，
由**三段式**产出（与项目既有形状一致）：

| 段 | 做什么 | 需要模型吗 |
|---|---|---|
| ① 确定性层 | 从语料里扫出「章号 ↔ 章标题」 | **不需要** |
| ② 模型层 | 补①没认出来的装置（给出探针） | 需要 |
| ③ 校验层 | 每个探针必须**真的出现在那一章的语料里** | **不需要** |

① 的三个来源（都是确定性的）：

- **目次**：GB 的「目 次」里 `- 5.4 前雾灯.... 31` 这种行 —— 章号与标题一次拿全；
- **正文标题行**：独立成行的短中文行（GB）或 `6.3. Front fog lamp` 这种英文行（UN）；
- **兜底**：候选池里认出的灯具名。

③ 的判据直接复用 `scripts/propose_parameters_c.py` 的 `verify_map()` 机制
（章号缺失 → 退出；名称探针找不到 → 退出）—— 那里已经把它用在 C 版上了，
这里把它提升成**通用**（GB 的中文探针、UN 的英文探针，同一套）。

## 用法

```
python scripts/build_device_chapter_map.py            # 写 data/device-chapter-map.json
python scripts/build_device_chapter_map.py --check     # 闸门用：现算 vs 入库，不一致就退出非零
```

**检查器不许写产物** —— `--check` 只比对，不写。
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CORPUS = os.path.join(ROOT, "dist", "mineru-v4-data.json")
SPECS = os.path.join(ROOT, "data", "parameter-specs.json")
CLAUSE_INDEX = os.path.join(ROOT, "data", "clause-index.json")
CROSS_MAP = os.path.join(ROOT, "data", "r48-chapter-map.json")
OUT = os.path.join(ROOT, "data", "device-chapter-map.json")

VERSIONS = ("A", "B", "C")


# --------------------------------------------------------------------------
# 通用小工具
# --------------------------------------------------------------------------
def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        return r.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------
# ① 确定性层：从语料扫出「章号 ↔ 章标题」
# --------------------------------------------------------------------------
# 目次行：`- 5.4 前雾灯.... 31`（GB 草案用四个点）／`- 5.7 制动灯 …… 30`（GB 2019 用省略号）
#          `- 6. Individual specifications .... 30`（UN）
# —— 三种省略号写法都要认：GB 两版就不一样，认错一种就丢掉一整版的目录。
RE_TOC = re.compile(
    r"^\s*[-–—]?\s*(\d+(?:\.\d+)*)\.?\s+(.+?)(?:\s*(?:\.{2,}|…{1,}|\.{3,}\s*…)\s*\d+)?\s*$"
)

# 正文里的英文章标题行：`6.3. Front fog lamp`
RE_EN_HEADING = re.compile(
    r"^\s*(\d+\.\d+)\.?\s+([A-Z][A-Za-z0-9 ,\-/()'\.]{2,60})\s*$"
)

# 独立成行的短中文行 —— GB 正文里的灯具名
RE_CJK_ONLY = re.compile(r"^[一-鿿/／()（）\s]+$")
RE_NOT_LAMP = re.compile(r"单位|选装|路试|试验|附录|参见|注[：:]|表\s*\d")


def is_cjk_heading(line: str) -> bool:
    t = line.strip()
    if not (2 <= len(t) <= 12):
        return False
    if not RE_CJK_ONLY.fullmatch(t) or t.startswith("第"):
        return False
    return not RE_NOT_LAMP.search(t)


def prefix_of(clause: str) -> str:
    parts = clause.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else ""


def scan_chapters(text: str):
    """从一版的全文里扫出「章前缀 → 标题」。返回 {prefix: {title, source}}。

    三个来源，**先到先得**（目次最可靠 —— 它是标准自己写的）：
      1. 目次行；
      2. 正文里的英文章标题行（UN 用）；
      3. 独立成行的中文标题（GB 用）。
    """
    out = {}

    def put(prefix, title, source):
        if not prefix or not title:
            return
        title = title.strip()
        if len(title) > 60:
            return
        # 已经在场就不覆盖（目次优先）
        if prefix in out:
            return
        out[prefix] = {"title": title, "source": source}

    lines = text.split("\n")
    offsets = []
    pos = 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln) + 1

    # ---- 1. 目次 --------------------------------------------------------
    # 目次是一段连续的「- x.y 标题 …… 页码」；先切出这一段，再逐行解析，
    # 否则正文里的「- 5.2.4.1 高度……」这类行会被误当成目次。
    toc_start = -1
    for i, ln in enumerate(lines):
        t = ln.strip()
        if t in ("目 次", "目次", "Contents", "CONTENTS"):
            toc_start = i
            break
    if toc_start >= 0:
        for i in range(toc_start + 1, min(len(lines), toc_start + 400)):
            ln = lines[i]
            if not ln.strip().startswith("-"):
                # 目次段结束（空行或非列表行）
                if not ln.strip():
                    break
                continue
            m = RE_TOC.match(ln)
            if m:
                put(prefix_of(m.group(1)), m.group(2), "toc")

    # ---- 2. 英文章标题行（UN） ----------------------------------------
    for ln in lines:
        m = RE_EN_HEADING.match(ln)
        if m:
            put(m.group(1), m.group(2), "heading")

    # ---- 3. 独立中文标题行（GB） --------------------------------------
    # 「灯具名」后面紧跟的**第一个条款号**的前两段 = 它住在哪一章。
    clause_any = re.compile(r"(?<![\d.])(\d+(?:\.\d+){1,4})(?![\d.])")
    for i, ln in enumerate(lines):
        if not is_cjk_heading(ln):
            continue
        # 找这一行**之后**的第一个条款号
        nxt = ""
        for m in clause_any.finditer(text, offsets[i]):
            if m.group(1).startswith("0."):
                continue
            nxt = m.group(1)
            break
        if nxt:
            put(prefix_of(nxt), ln.strip(), "heading")

    return out


# --------------------------------------------------------------------------
# 装置 → 它的中文词（与 TS 侧 dominantDeviceToken 同规则）
# --------------------------------------------------------------------------
def dominant_token(names):
    """同一 id 前缀的兄弟参数名的**共有中文前缀**。

    与 `server/reports/specAgent.ts` 的 `dominantDeviceToken()` 同规则：
    取长度 ≥2 的公共中文前缀，出现次数要过半且 ≥2 —— 「近光灯最大离地高度」
    与「近光灯最大光强」的共有前缀是「近光灯」，而「前雾灯越野车型放宽高度」
    混进来时会被它排掉（那是归错前缀的别的灯）。
    """
    list_ = [str(n or "") for n in names if n]
    if len(list_) < 2:
        return ""
    need = -(-len(list_) // 2)
    for ln in range(6, 1, -1):
        counts = Counter()
        for n in list_:
            cn = re.match(r"^[一-鿿]+", n)
            if not cn:
                continue
            s = cn.group(0)
            if len(s) < ln:
                continue
            counts[s[:ln]] += 1
        for cand, c in counts.items():
            if c >= need and c >= 2:
                return cand
    return ""


# --------------------------------------------------------------------------
# 装置的**关键词** —— 探针校验用的那个词
# --------------------------------------------------------------------------
def key_term(names, titles=()):
    """这个装置的**关键词**：兄弟规格名里**过半**都出现的那个中文词。

    为什么不能直接用 `dominant_token()`：那个算的是「共有中文**前缀**」，
    于是「ADS 标志灯最小离地高度」这种**以字母开头**的名字前缀是空的，
    探针就无从谈起。而「标志灯」这个词在 8 条 ADS 规格名里都出现 ——
    它才是这个装置在语料里该被找到的样子。

    算不出来时返回 "" —— **宁可空着**：没有关键词就验不了章，
    那一条就该进残余，而不是靠猜。
    """
    list_ = [str(n or "") for n in names if n]
    if len(list_) < 2:
        return ""
    need = -(-len(list_) // 2)
    counts = Counter()
    for n in list_:
        cn = "".join(re.findall(r"[\u4e00-\u9fff]", n))
        for ln in range(2, 9):
            for i in range(len(cn) - ln + 1):
                counts[cn[i:i + ln]] += 1
    supported = [(t, c) for t, c in counts.items() if c >= need and c >= 2]
    if not supported:
        return ""
    top_count = max(c for _, c in supported)
    pool = [t for t, c in supported if c == top_count]

    # 候选里**出现在章标题里的那些**才是标准自己的词 ——
    # 「前雾灯」是章标题，「前雾灯最」只是名字截断的尾巴。
    # 拿碎片当探针，正文里当然没有 → 那一族全被判成「认不出」。
    in_vocab = [t for t in pool if any(t in title for title in titles)]
    if in_vocab:
        return max(in_vocab, key=len)

    # 都不在词汇表里 → 退回「至少 3 字里最短的」
    # （不能取最长：「前雾灯最」那种尾巴探不到）
    long_enough = [t for t in pool if len(t) >= 3]
    if long_enough:
        return min(long_enough, key=len)
    return min(pool, key=len)


def display_label(names):
    """兄弟规格名的**最长共有中文前缀**（不截断）—— 给**人看**的词。

    `dominant_token()` 最多取 6 个字，那是**匹配**用的（要短才具体）；
    拿它写进残余的理由就会出现「可变光强光信」这种半截词。
    """
    runs = []
    for n in names:
        m = re.match(r"^[\u4e00-\u9fff]+", str(n or ""))
        if m:
            runs.append(m.group(0))
    if len(runs) < 2:
        return ""
    pre = runs[0]
    for r in runs[1:]:
        i = 0
        while i < min(len(pre), len(r)) and pre[i] == r[i]:
            i += 1
        pre = pre[:i]
    return pre if len(pre) >= 2 else ""


def chapter_bodies(clause_index):
    """每版的「章 → 正文」。

    从 `data/clause-index.json` 拼：章号是条款号的前两段。
    探针校验要问的问题是「这一章的正文里有没有这个装置」，
    所以要的是**正文**，不是章标题。
    """
    out = {}
    for v, clauses in (clause_index.get("_clauses") or {}).items():
        bodies = defaultdict(list)
        for num, item in (clauses or {}).items():
            p = prefix_of(str(num))
            if not p:
                continue
            body = str((item or {}).get("body") or "")
            if body:
                bodies[p].append(body)
        out[v] = {k: "\n".join(vs) for k, vs in bodies.items()}
    return out


def legacy_prefixes(dev, rows, v):
    """旧路：从**现有手写 spec 的正则**反推章号（与 TS 侧同规则）。

    这是「人的背书」：那 801 条正则是人写的、回过原文的。
    机器认的章与它不一致时，**不猜** —— 进残余。
    换标准时没有手写 spec，这道对账自动失效（`rows` 里没有 patterns）。
    """
    names = [r.get("name", "") for r in rows]
    token = dominant_token(names)
    counts = {}
    for r in rows:
        if token and token not in str(r.get("name", "")):
            continue
        src = (r.get("patterns") or {}).get(v, {}).get("source")
        if not src:
            continue
        m = re.match(r"^\s*(\d+(?:\\?\.\d+)+)", str(src))
        if not m:
            continue
        parts = m.group(1).replace("\\", "").split(".")
        if len(parts) < 2:
            continue
        p = ".".join(parts[:2])
        counts[p] = counts.get(p, 0) + 1
    if not counts:
        return []
    mx = max(counts.values())
    return sorted([p for p, n in counts.items() if n == mx])


# --------------------------------------------------------------------------
# ② + ③：把装置接到章上；每个探针必须真的在语料里
# --------------------------------------------------------------------------
# --------------------------------------------------------------------------
# 装置 → 章：**按名字打**（确定性），但**只认没有歧义的**
# --------------------------------------------------------------------------
def title_alternatives(title: str):
    """章标题的**别名集合**。

    「近光灯（无自适应模式）」→ {"近光灯"}；
    「转向信号灯（转向灯）」→ {"转向信号灯", "转向灯"}。
    括号里往往正是这个词的另一种叫法 —— 带上它，
    「转向灯」这个词也能接回「转向信号灯」那一章。
    """
    alts = []
    core = re.split(r"[（(]", title)[0].strip()
    if core:
        alts.append(core)
    for m in re.finditer(r"[（(]([^）)]+)[）)]", title):
        a = m.group(1).strip()
        # 「近光灯和/或远光灯」这种是**两个**灯的合称，不能当别名
        if a and "和" not in a and "/" not in a and "或" not in a:
            alts.append(a)
    return alts


def score_chapter(names, title):
    """这个装置与这一章有多像。

    返回 (命中的别名长度, 命中了几条兄弟参数的名字)。

    **只认「别名原样出现在名字里」这一种证据** ——
    试过更宽的口径（标题与名字的最长公共子串），结果是**误接**：
    「车辆灯具…」会接上「灯具定义」那一章、「照度…」会接上「发光徽标」那一章。
    弱证据在这个项目里全是负资产：接错章 → 候选句混进别的灯的条文 →
    agent 挑错灯（值对、条款错是最贵的错）。

    认不出的装置**进残余**，由 agent 补 —— 宁可空着，不可错着。
    """
    best_len = 0
    hits = 0
    for alt in title_alternatives(title):
        ln = len(alt)
        n = sum(1 for nm in names if alt in str(nm or ""))
        if n and ln > best_len:
            best_len = ln
            hits = n
    return best_len, hits


def excluded_by_qualifier(names, title):
    """这一章是不是**明确说了不含**这个装置。

    GB 的章标题常带限定：「远光灯（**无自适应模式**）」。
    而装置名叫「自适应远光灯自动关闭环境照明阈值」——
    按字面「远光灯」它就命中了那一章，**但那一章恰恰是不含它的**。

    所以：标题的括号里带「无」时，把括号里的词拆出来，
    装置名里出现同一个词 → **这一章排除**。

    判错的后果是拿错章的候选句 → agent 很可能挑错灯 ——
    那正是这个项目最贵的一类错（值对、条款错）。
    """
    for m in re.finditer(r"[（(]([^）)]*无[^）)]*)[）)]", title):
        qual = m.group(1)
        cn = "".join(re.findall(r"[一-鿿]", qual))
        # 从长到短找**出现在装置名里的那个词**：「无自适应模式」→ 「自适应」。
        # 只认 ≥3 个字的 —— 2 个字（「模式」）太容易撞车，撞车就误杀了。
        hit = False
        for ln in range(min(5, len(cn)), 2, -1):
            for i in range(len(cn) - ln + 1):
                term = cn[i:i + ln]
                if term.startswith("无"):
                    continue
                if any(term in str(nm or "") for nm in names):
                    hit = True
                    break
            if hit:
                break
        if hit:
            return True
    return False


def build():
    corpus = read_json(CORPUS, {}) or {}
    specs = (read_json(SPECS, {}) or {}).get("specs", [])
    clause_index = read_json(CLAUSE_INDEX, {}) or {}
    cross = (read_json(CROSS_MAP, {}) or {}).get("map", {}) or {}

    # 源 PDF 指纹（照 clause-index.json 的 _sourcePdfs）
    source_sha = {}
    for v, info in (clause_index.get("_sourcePdfs") or {}).items():
        source_sha[v] = info.get("sha256", "")

    # ---- ① 每版的章表 -------------------------------------------------
    chapters = {}
    texts = {}
    for v in VERSIONS:
        t = str((corpus.get(v) or {}).get("fullText", ""))
        texts[v] = t
        found = scan_chapters(t)
        chapters[v] = {
            p: {
                "title": info["title"],
                "probes": [info["title"]],
                "source": info["source"],
            }
            for p, info in sorted(
                found.items(), key=lambda kv: [int(x) for x in kv[0].split(".") if x.isdigit()]
            )
        }

    # ---- 把**人工核过的跨标准对照表**里的 UN 章并进 C 的章表 ----------
    #
    # 为什么并：C 版有几个章的标题在 MinerU 抽取时被并进了表格行
    # （§6.1「Main-beam headlamp」就是如此）→ 标题扫不出来 → 章表缺一格。
    # 而那张对照表的每一条都**带探针、且探针回源核过**（闸门守着）——
    # 它是「机器扫不出来但人核过」的那部分，正好补在这里。
    for gb_prefix, entry in (cross or {}).items():
        r48 = str(entry.get("r48") or "")
        rp = prefix_of(r48)
        probe = str(entry.get("probe") or "").strip()
        if not rp or not probe:
            continue
        if rp in chapters.get("C", {}):
            continue
        if probe not in texts.get("C", ""):
            continue  # 探针不在语料里 → 宁可留空，不写一个认不出来的章
        chapters.setdefault("C", {})[rp] = {
            "title": probe,
            "probes": [probe],
            "source": "cross-map",
        }
    for v in chapters:
        chapters[v] = dict(
            sorted(chapters[v].items(), key=lambda kv: [int(x) for x in kv[0].split(".") if x.isdigit()])
        )

    # ---- 装置清单（来自 spec 的 id 前缀与名字） ------------------------
    by_device = defaultdict(list)
    for s in specs:
        dev = str(s.get("id", "")).split(".")[0]
        if dev:
            by_device[dev].append(s)

    devices = {}
    residue = []
    disagreements = []
    bodies = chapter_bodies(clause_index)

    # 全部版本的章标题 = 标准自己的**词汇表**（探针只能从这里挑词）
    vocab = []
    for v in VERSIONS:
        for info in chapters.get(v, {}).values():
            vocab.append(info["title"])
            vocab.extend(title_alternatives(info["title"]))

    for dev, rows in sorted(by_device.items()):
        names = [r.get("name", "") for r in rows]
        token = dominant_token(names)
        key = key_term(names, vocab)
        label = display_label(names)
        per_version = {}
        ambiguous = []

        # 这一版在 spec 里有结论的版本（没有结论的不必接章）
        wanted = [
            v for v in VERSIONS
            if any((r.get("patterns") or {}).get(v) or (r.get("absent") or {}).get(v) for r in rows)
        ]

        for v in VERSIONS:
            # ---- ① 机器的判断：名字打分 + **语料探针**筛选 ------------------
            #
            # 先筛后排序 —— 顺序反了就会接错灯：
            # 「倒车灯」出现在「角灯关闭车速阈值（倒车灯熄灭后）」里，
            # 所以「倒车灯」那一章的名字匹配更长、排到前面，
            # 而「角灯」那一章的正文里才有「角灯」这个词。
            scored = []
            for prefix, info in chapters[v].items():
                if excluded_by_qualifier(names, info["title"]):
                    continue
                bl, hits = score_chapter(names, info["title"])
                if bl < 2 or hits < 1:
                    continue
                if key and key not in bodies.get(v, {}).get(prefix, ""):
                    continue  # 这一章的正文里没有这个装置 → 不是它住的章
                scored.append((bl, hits, prefix))
            scored.sort(reverse=True)

            machine = ""
            rival = ""
            if scored:
                top = scored[0]
                second = scored[1] if len(scored) > 1 else (0, 0, "")
                machine = top[2]
                # 先比**匹配长度**（这个灯叫什么），再比**命中了几条兄弟参数**
                # （好几条参数都提到它，说明这章确实是它的）。
                #
                # 长度优先的理由：「光信号投射功能」（6 字）与「倒车灯」（3 字）比，
                # 前者才是「光信号投射」这个装置所在的章 —— 而「倒车灯」命中更多
                # 兄弟参数（它确实在好几条规格名里出现）。
                # 拿命中数优先，就会把这一族接到**倒车灯**那一章去。
                #
                # 长度相同（近光灯 vs 前雾灯，都是 3 字）时靠命中数分胜负
                # （14 : 1，近光灯赢）。
                #
                # 两个数都相同 → **不猜**（rival 与 winner 并列 → 进残余）。
                if (top[0], top[1]) <= (second[0], second[1]):
                    rival = second[2]

            # ---- ② 人的背书：手写 spec 反推的章 ------------------------------
            #
            # 那 801 条正则是人写的、回过原文的 —— 它比机器可信。
            # 机器认的与它不一致 → **记下来**（机器层要改进的地方），
            # 但**答案取它的**：人核过的不用机器再确认一遍。
            #
            # 换标准时没有手写 spec，这道背书自动失效（legacy 为空），
            # 于是只剩①（而且必须过探针）。
            legacy = legacy_prefixes(dev, rows, v)
            if legacy:
                per_version[v] = legacy
                if machine and machine not in legacy:
                    disagreements.append(
                        {
                            "device": dev,
                            "version": v,
                            "basis": "手写 spec 反推的章是 %s，机器认成 %s（%s）—— 机器认错了，换标准时这里会掉"
                            % (
                                "/".join(legacy),
                                machine,
                                chapters[v].get(machine, {}).get("title", ""),
                            ),
                        }
                    )
                continue

            # ---- ③ 没有背书 → 只认**过了探针**的机器判断 ----------------------
            #
            # 「过了探针」= 这一章的正文里真的有这个装置。
            # 没有关键词的装置**不认**（验不了就别认）—— 宁可空着，不可错着。
            if machine and not rival and key:
                per_version[v] = [machine]
                continue
            if machine and rival:
                ambiguous.append(
                    {
                        "version": v,
                        "candidates": [machine, rival],
                        "titles": [
                            chapters[v].get(machine, {}).get("title", ""),
                            chapters[v].get(rival, {}).get("title", ""),
                        ],
                    }
                )
                continue

            # ---- ④ 中文名对不上这一版的标题（UN 是英文）→ 走**跨标准映射** ----
            #
            # 注意那张表的键是**哪一版的章号**：它是 GB 4785-2019（B）的编号 ——
            # 草案（A）多了一章「带有自适应模式的前照灯」，后面全部错位一位。
            # 用错版本，A 的 5.4（前雾灯）会被当成 B 的 5.4（倒车灯）→ C 接到 6.4，
            # 于是**近光灯接到了倒车灯那一章**。所以这里只认 **B 的章号**。
            #
            # 而且**只用于 UN 那一版**：那张表本来就是 GB↔UN 的对照，
            # 拿它去接 GB 的章号会接到「6.x」去（A 的 6.x 是「驾驶员辅助投射功能」）。
            if v == "C":
                b_prefix = per_version.get("B")
                if b_prefix:
                    entry = cross.get(b_prefix[0]) or {}
                    r48 = str(entry.get("r48") or "")
                    rp = prefix_of(r48)
                    if rp and rp in chapters.get(v, {}):
                        per_version[v] = [rp]
                        continue

            # ---- ⑤ 认不出 → 进残余（这是 agent 该补的地方）------------------
            #
            # 残余**永远记**，不只记「spec 里这一版有结论」的 ——
            # 换标准时还没有结论，正因如此才知道**哪些章要补**。
            if not key:
                basis = "算不出这个装置的关键词（兄弟规格名里过半共有的中文词找不着）—— 认不出它住在哪一章"
            elif rival:
                basis = "有多个章同样像这个装置，分不出主章"
            else:
                basis = "语料里没扫到与「%s」同名的章" % (label or token or key)
            residue.append(
                {
                    "device": dev,
                    "version": v,
                    "token": token,
                    "key": key,
                    "label": label,
                    "needed": v in wanted,
                    "basis": basis,
                }
            )

        devices[dev] = per_version
        for a in ambiguous:
            residue.append(
                {
                    "device": dev,
                    "version": a["version"],
                    "token": token,
                    "key": key,
                    "basis": "有多个章同样像这个装置，分不出主章：%s"
                    % " / ".join("%s（%s）" % (t, c) for c, t in zip(a["candidates"], a["titles"])),
                    "candidates": [
                        {"section": c, "title": t} for c, t in zip(a["candidates"], a["titles"])
                    ],
                }
            )

    # ---- ③ 校验：每个探针必须真的出现在那一版的语料里 -----------------
    bad_probes = []
    for v, cmap in chapters.items():
        for prefix, info in cmap.items():
            for probe in info["probes"]:
                if probe and probe not in texts[v]:
                    bad_probes.append({"version": v, "section": prefix, "probe": probe})

    doc = {
        "_why": (
            "**装置↔章映射** —— 取值规格提议 agent 的输入。\n"
            "\n"
            "它替代的是 `deviceChapterPrefixes()` 原来「从现有手写 spec 的正则反推章号」的做法 ——\n"
            "那一处在换标准时是**死结**：没有手写 spec 就推不出章号，没有章号就没有候选，\n"
            "agent 跑不起来，最后还是得手写 spec。\n"
            "\n"
            "本文件由 `scripts/build_device_chapter_map.py` 从**语料**扫出（确定性），\n"
            "章号与标题的对照不依赖任何手写 spec。\n"
            "\n"
            "换标准时：**重跑这个脚本**（语料换了 → 章表全变），\n"
            "装置↔章的接续由 agent 补（探针必须过校验）。"
        ),
        "_generator": "scripts/build_device_chapter_map.py @ %s" % git_sha(),
        "_sourceSha256": source_sha,
        "chapters": chapters,
        "devices": devices,
        "_residue": {
            "devicesWithoutChapter": residue,
            "machineDisagreements": disagreements,
            "probesNotInCorpus": bad_probes,
        },
    }
    return doc


def main(argv):
    doc = build()
    if "--check" in argv:
        old = read_json(OUT, None)
        if old is None:
            print("[device-chapter-map] 入库那份不存在：跑 python scripts/build_device_chapter_map.py")
            return 1
        a = json.dumps(old, ensure_ascii=False, sort_keys=True)
        b = json.dumps(doc, ensure_ascii=False, sort_keys=True)
        # 生成时刻与 git sha 会每次不同 —— 比内容，不比这两样
        for k in ("_generator",):
            a = a.replace(json.dumps(old.get(k), ensure_ascii=False), "")
            b = b.replace(json.dumps(doc.get(k), ensure_ascii=False), "")
        if a != b:
            print("[device-chapter-map] 入库那份**过期**了（语料或 spec 变了）")
            print("  重出：python scripts/build_device_chapter_map.py")
            return 1
        print(
            "[device-chapter-map] 与当前语料一致：%d 个装置 · 残余 %d 条"
            % (len(doc["devices"]), len(doc["_residue"]["devicesWithoutChapter"]))
        )
        return 0

    with io.open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print(
        "[device-chapter-map] 写到 %s：%d 版 · %d 个装置 · 残余 %d 条"
        % (
            os.path.relpath(OUT, ROOT),
            len(doc["chapters"]),
            len(doc["devices"]),
            len(doc["_residue"]["devicesWithoutChapter"]),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
