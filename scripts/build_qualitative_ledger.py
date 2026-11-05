# -*- coding: utf-8 -*-
"""生成 `data/qualitative-ledger.json`：**按义务面建立的全量定性义务台账**（客户 DR-013）。

## 客户要的

> 「§11.9 列 9 项且非穷举；附录 H 给材料不替读者下结论」
> 「定性义务没有形成完整、可执行的差异台账」
> 「**证据材料不等于差异分析**」「客户仍需自行判断大量条款」
> 修改建议：**按义务面建立全量台账，优先裁定 H 中高相似条目并回流摘要**

所以台账的**单位**不是「9 条已裁定」，而是**每一个义务面**：

    （装置 × 义务面）→ A 怎么说 · B 怎么说 · C 怎么说 · 判定 · 依据

台账的每一行都带**判定**（不是只给材料），并按**相似度**排序 ——
「优先裁定高相似条目」靠的是**把最像的排在最前面**，而不是全都人工看一遍。

## 判定分三层，从便宜到贵

| 层 | 判定 | 判据 | 谁做 |
|---|---|---|---|
| 1 | 同文 | 归一化后逐字相同 | 机器 |
| 1 | **非实质·编号重排** | 交叉引用号不同、其余相同 | 机器 |
| 1 | **非实质·措辞/格式** | 差异只在标点/量词/要求词 | 机器 |
| 1 | **实质·限值或口径不同** | 限值三元组不同（长度已折算成毫米） | 机器 |
| 1 | **实质·义务强度不同** | 去掉要求词后相同 | 机器 |
| 2 | **人工裁定** | 机器判不出来的，**人读原文判** | 人（`data/qualitative-adjudications.json`） |
| 3 | **表述不等价·需人工判读** | 还没裁的，按相似度排序等人工 | —— |

> **宁可空着，不可错着**：机器判不出来的**不猜**，
> 落到「需人工判读」并附差异片段；人工裁过的记在**独立的登记表**里，
> 与机器判据分开 —— 这样「机器判的」与「人判的」不会互相污染。

## 三条来源分开

- **A/B 侧**：`data/qualitative-diff.json`（附录 H 的配对结果，已逐条回原文验过）；
- **C 侧**：`data/r48-chapters.json` 的装置对应 + **C 版源 PDF 的条款块**
  （§6.x.1 Presence / §6.x.2 Number / … / §6.x.9 Other requirements），
  原文与页码**逐字照录**；
- **人工裁定**：`data/qualitative-adjudications.json`（人手判的，带理由）。

## 用法

```bash
python scripts/build_qualitative_ledger.py     # 生成 data/qualitative-ledger.json
python scripts/verify_qualitative_ledger.py    # 核验（闸门会跑）
"""
from __future__ import annotations

import difflib
import io
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
C_PDF = ROOT / "uploaded-docs" / "92b2563197df022a.pdf"

# ---------------------------------------------------------------- 归一化

FULLWIDTH = {
    "，": ",", "。": ".", "：": ":", "；": ";", "（": "(", "）": ")",
    "％": "%", "～": "~", "、": ",", "“": '"', "”": '"', "‘": "'", "’": "'",
    "－": "-", "—": "-", "　": " ", "【": "[", "】": "]", "［": "[", "］": "]",
}

CN_DIGITS = {"零": "0", "一": "1", "二": "2", "两": "2", "三": "3", "四": "4",
             "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}

# ---------------------------------------------------------------- 同义词表（**人工核过**）
#
# 这张表里每一组都是**真同义** —— 判据是「两条法规在同一个语境里用不同的词说同一件事」。
#
# ## 为什么可以全局替换
#
# 这张表**只用于「相等判定」**：把两边的同义词都换成同一个规范形，再比是否相等。
# 真正危险的是**把不同的概念映到同一个形**（例：光强 ↔ 照度 ——
# 那是两个不同的物理量，**绝不能进这张表**）。
#
# 表里**故意不放**的（它们是术语差异，要人判读）：
#   光强/照度 · 光学/视觉 · 声音/听觉 · 观察区域/扩散区域 ·
#   垂直方向/由3.15定义的α和β · 光源/LED · 发光/照明 · 安装/使用
SYNONYM_GROUPS: list[list[str]] = [
    ["点亮", "打开", "开启"],
    ["熄灭", "关闭"],
    ["挂车", "拖车"],
    ["强制", "必须"],
    ["若", "如果"],
    ["且", "并"],
    ["作", "做"],
    ["截", "切"],
    ["能", "可以"],
    ["应", "应当"],
    ["前部", "前面"],
    ["装于", "装在"],
]

PUNCT_CHARS = set(",.;:!?()[]{}、，。；：！？（）【】…—－-~·\"'“”‘’ ")
MEASURE_CHARS = set("的地得了只个辆部位等和与及而则之其所以位条根台头套盏支顶对双份")

OBLIGATION_WORDS = [
    "不应", "不得", "禁止", "必须", "应当", "应", "须", "允许", "不允许",
    "无需", "不能", "不可", "宜", "可",
]

COMPARATORS = [
    ("不大于", "<="), ("不小于", ">="), ("不超过", "<="), ("不小于等于", ">="),
    ("大于等于", ">="), ("小于等于", "<="), ("不高于", "<="), ("不低于", ">="),
    # 「小于或等于」「大于或等于」是「小于等于」「大于等于」的另一种写法 ——
    # 不认它，B 的「小于或等于1500mm」会被当成没有口径的裸数值，造出假差异
    ("小于或等于", "<="), ("大于或等于", ">="),
    ("不超出", "<="), ("不超", "<="), ("不小于者", ">="),
    ("超过", ">"), ("超出", ">"), ("少于", "<"), ("多于", ">"),
    ("小于", "<"), ("大于", ">"),
    ("≤", "<="), ("≥", ">="), ("≤", "<="), ("<=", "<="), (">=", ">="),
    ("<", "<"), (">", ">"),
]

LENGTH_TO_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "dm": 100.0}
UNIT_ALT = r"mm|cm|m|dm|deg|度|只|个|支|盏|cd|lx|lm|%|°|对|辆|W|km/h|kmh|kg|m2|cm2"

# ---------------------------------------------------------------- 义务面

# GB 的「款」→ 义务面 → UN R48 §6.x 的对应条款
GB_ASPECT_TO_SURFACE = {
    "配备": "配备（Presence）",
    "数量": "数量（Number）",
    "布局": "布局（Arrangement）",
    "安装位置": "安装位置（Position）",
    "高度": "几何可见度（Geometric visibility）",
    "纵向": "几何可见度（Geometric visibility）",
    "横向": "几何可见度（Geometric visibility）",
    "水平方向角": "几何可见度（Geometric visibility）",
    "水平方向": "几何可见度（Geometric visibility）",
    "横向和高度": "几何可见度（Geometric visibility）",
    "几何可见度": "几何可见度（Geometric visibility）",
    "方向": "发光方向（Orientation）",
    "安装方向": "发光方向（Orientation）",
    "电路连接": "电路连接（Electrical connections）",
    "指示器": "指示器（Tell-tale）",
    "其他要求": "其他要求（Other requirements）",
}

# R48 §6.x 的款序 —— 每个装置下都一样（Presence=1 … Other requirements=9）
R48_ASPECT_ORDER = [
    "Presence", "Number", "Arrangement", "Position", "Geometric visibility",
    "Orientation", "Electrical connections", "Tell-tale", "Other requirements",
]
SURFACE_TO_R48_ASPECT = {
    "配备（Presence）": "Presence",
    "数量（Number）": "Number",
    "布局（Arrangement）": "Arrangement",
    "安装位置（Position）": "Position",
    "几何可见度（Geometric visibility）": "Geometric visibility",
    "发光方向（Orientation）": "Orientation",
    "电路连接（Electrical connections）": "Electrical connections",
    "指示器（Tell-tale）": "Tell-tale",
    "其他要求（Other requirements）": "Other requirements",
}


# ---------------------------------------------------------------- 工具函数

def normalize(s: str) -> str:
    t = s or ""
    for k, v in FULLWIDTH.items():
        t = t.replace(k, v)
    t = t.replace("㎜", "mm").replace("毫米", "mm").replace("厘米", "cm").replace("分米", "dm")
    t = t.replace("㎡", "m2").replace("㎟", "cm2").replace("º", "°")
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[零一两二三四五六七八九十](?=[只个支盏辆对])",
               lambda mm: CN_DIGITS[mm.group(0)], t)
    t = t.replace("一对", "1对").replace("两对", "2对")
    # 区间写法：「1.80～2.10m」—— A 省略了下限的单位，B 写「1.80m~2.10m」。
    # 不把单位补到下限上，两边会被当成「一个有一个没有」 —— 假差异。
    t = re.sub(r"([0-9]+(?:\.[0-9]+)?)\s*[~～]\s*([0-9]+(?:\.[0-9]+)?)\s*(mm|cm|m)",
               r"\1 \3 ~ \2 \3", t)
    return t


def canonical(s: str) -> str:
    """把同义词换成规范形（**只用于相等判定**）。

    组内按长度降序替换，避免「短词是长词的子串」造成的二次替换。
    """
    t = s
    for grp in SYNONYM_GROUPS:
        canon = grp[0]
        for w in sorted(grp[1:], key=len, reverse=True):
            t = t.replace(w, canon)
    return t


def seg_kind(a: str, b: str) -> str:
    seg = (a or "") + (b or "")
    if not seg:
        return "标点"
    if all(c in PUNCT_CHARS for c in seg):
        return "标点"
    if any(c.isdigit() for c in seg):
        return "数值"
    rest = seg
    for w in sorted(OBLIGATION_WORDS, key=len, reverse=True):
        if rest.startswith(w) or rest.endswith(w):
            rest = rest.replace(w, "")
    if not rest:
        return "要求词"
    if all(c in MEASURE_CHARS for c in rest):
        return "量词助词"
    return "其他"


def diff_segments(a: str, b: str) -> list[dict]:
    out = []
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        x, y = a[i1:i2], b[j1:j2]
        out.append({"a": x, "b": y, "kind": seg_kind(x, y)})
    return out


def mask_xrefs(t: str) -> str:
    """把交叉引用的条款号换成占位符 —— 编号重排不是实质差异。

    判据是**上下文**（按/符合/参照/见/第/根据/满足/依照/依据 后面跟一个号），
    不是「后面跟什么」—— 「按5.6.2或5.7.2要求」「符合5.4.6.1.2 a)要求」
    「按5.1.7.2所述」后面的词各不相同，只按后缀认会漏掉一大半。
    限值不会被误伤：限值后面带单位（mm/度/只…），不带点号。
    """
    t = re.sub(r"(?<=[按符合参照见第根据满足依照依据])[0-9]+(?:\.[0-9]+)+", "§", t)
    t = re.sub(r"[0-9]+(?:\.[0-9]+)+(?=[规定条款款项章节的要求])", "§", t)
    t = re.sub(r"附录([A-Z])", "附录§", t)
    t = re.sub(r"([0-9]+(?:\.[0-9]+)+)([a-z])\)", r"\1§)", t)
    t = re.sub(r"(?<=按)附录([A-Z])", "附录§", t)
    return t


def is_lead_in(text: str, label: str) -> bool:
    """引出条款：正文只有款名，实质内容在子条款里 —— 逐字对读它没有意义。"""
    t = (text or "").strip()
    lab = (label or "").strip()
    if not lab:
        return False
    return t.startswith(lab) and len(t) <= len(lab) + 3


def is_truncated(text: str) -> bool:
    """材料被截断（断在词中间）—— 拿截断的材料比，**不能**判等也不能判不等。"""
    t = (text or "").strip()
    if not t:
        return False
    return not re.search(r"[。；：;:)）\d\"\]】.]$", t)


def _fmt(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


def extract_limits(t: str) -> list[tuple[str, str, str]]:
    """抽出「口径 + 数值 + 单位」；长度单位折算成毫米（否则 6m 与 6000mm 会被当成不同）。"""
    out: list[tuple[str, str, str]] = []
    cm = dict(COMPARATORS)
    pat = re.compile(
        r"(不大于|不小于|不超过|不小于等于|大于等于|小于等于|小于或等于|大于或等于|不高于|不低于|"
        r"不超出|不超|超过|超出|少于|多于|小于|大于|≤|≥|<=|>=|<|>)"
        r"\s*([0-9]+(?:\.[0-9]+)?)\s*(" + UNIT_ALT + r")")
    for m in pat.finditer(t):
        op = cm.get(m.group(1), m.group(1))
        val, unit = m.group(2), m.group(3)
        if unit in LENGTH_TO_MM:
            val, unit = _fmt(float(val) * LENGTH_TO_MM[unit]), "mm"
        if unit == "度":
            unit = "°"      # 度 与 ° 是同一个单位，只是写法不同
        out.append((op, val, unit))
    pat2 = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(" + UNIT_ALT + r")")
    seen = set()
    for m in pat2.finditer(t):
        val, unit = m.group(1), m.group(2)
        if unit in LENGTH_TO_MM:
            val, unit = _fmt(float(val) * LENGTH_TO_MM[unit]), "mm"
        if unit == "度":
            unit = "°"
        if (val, unit) in seen:
            continue
        seen.add((val, unit))
        if not any(x[1] == val and x[2] == unit for x in out):
            out.append(("", val, unit))
    # **去重**：同一个限值在一句里被提到两次（例：「离地高度小于750mm」重复出现）
    # 不是「多了一个限值」—— 比的是**限值集合**，不是出现次数。
    return sorted(set(out))


def strip_obligations(t: str) -> str:
    for w in sorted(OBLIGATION_WORDS, key=len, reverse=True):
        t = t.replace(w, "")
    return t


def classify(a_text: str, b_text: str, label: str = "") -> dict:
    """机器判定（第一层）。"""
    a = normalize(a_text)
    b = normalize(b_text)
    # 引出条款：本条正文只有款名，实质内容在子条款 —— 逐字对读它没有意义
    if is_lead_in(a_text, label) or is_lead_in(b_text, label):
        return {"verdict": "引出条款·实质内容见子条款",
                "basis": "本条正文只有款名，实质内容在子条款里（附录 H.2 已把子条款列出）",
                "similarity": 0.0, "segments": []}
    # 材料截断：拿截断的材料比，**不能**判等也不能判不等
    if is_truncated(a_text) or is_truncated(b_text):
        return {"verdict": "材料截断·不可判定",
                "basis": "一侧的原文在抽取时被截断（断在词中间）—— 材料不完整，不判",
                "similarity": 0.0, "segments": []}
    if a == b:
        return {"verdict": "同文", "basis": "归一化后逐字相同", "similarity": 1.0, "segments": []}
    am, bm = mask_xrefs(a), mask_xrefs(b)
    if am == bm:
        return {"verdict": "非实质·编号重排",
                "basis": "只有交叉引用的条款号不同（编号重排），其余逐字相同",
                "similarity": 1.0, "segments": []}
    ac, bc = canonical(am), canonical(bm)
    if ac == bc:
        return {"verdict": "非实质·措辞/格式",
                "basis": "经人工核过的同义词表归一后相同（措辞、单位写法、括号等格式差异）",
                "similarity": 1.0, "segments": []}
    la, lb = extract_limits(a), extract_limits(b)
    ratio = difflib.SequenceMatcher(None, ac, bc, autojunk=False).ratio()
    segs = diff_segments(ac, bc)
    if la != lb:
        # 限值集合不同，但**文字差得多** → 差异不止在限值上（多半是条款内容不同）
        if ratio < 0.9:
            return {"verdict": "实质·内容不同",
                    "basis": f"两版条文内容不同（限值集合也不同：A={la or '无'} ／ B={lb or '无'}）",
                    "similarity": ratio, "segments": segs}
        return {"verdict": "实质·限值或口径不同",
                "basis": f"限值不同：A={la or '无'} ／ B={lb or '无'}",
                "similarity": ratio, "segments": segs}
    kinds = {k for _x, _y, k in segs}
    if kinds and kinds <= {"标点", "要求词", "量词助词"}:
        detail = "；".join(f"A「{x}」/B「{y}」" for x, y, _k in segs[:6])
        if kinds == {"要求词"}:
            return {"verdict": "实质·义务强度不同",
                    "basis": "差异只在要求词（应/不应/必须/允许…）—— 义务的强度变了",
                    "similarity": ratio, "segments": segs}
        return {"verdict": "非实质·措辞/格式",
                "basis": "差异只在" + "、".join(sorted(kinds)) + "（" + detail + "）",
                "similarity": ratio, "segments": segs}
    if strip_obligations(ac) == strip_obligations(bc):
        return {"verdict": "实质·义务强度不同",
                "basis": "去掉要求词后逐字相同 —— 差异只在要求词（应/不应/必须/允许…）",
                "similarity": ratio, "segments": segs}
    return {"verdict": "表述不等价·需人工判读",
            "basis": "文字差异超出机械判据能覆盖的范围",
            "similarity": ratio, "segments": segs}


# ---------------------------------------------------------------- C 侧抽取

def extract_c_aspects() -> dict[str, dict]:
    """从 C 版**源 PDF** 抽 §6.x 各装置的每一款（条款号 + 标题 + 原文 + 页码）。

    为什么不用 MinerU 语料：语料里这些条款的标题行常被并进正文行，
    26 个装置里有一半抽不全 —— **抽不全的条款不能进台账**（宁可空着）。
    源 PDF 的条款号是干净的（6.5.1. / 6.5.2. / …）。
    """
    doc = fitz.open(str(C_PDF))
    pages = [p.get_text() for p in doc]
    doc.close()

    out: dict[str, dict] = {}
    for ch in range(1, 27):
        key = f"6.{ch}"
        head_re = re.compile(r"^\s*" + re.escape(key) + r"\.\s+([A-Z][^\n]{2,60})\s*$", re.M)
        found: dict[int, tuple[int, str, str]] = {}   # 款号 → (页, 标题, 原文)
        for pno, text in enumerate(pages, start=1):
            for m in re.finditer(r"^\s*" + re.escape(key) + r"\.(\d+)\.\s*\n?\s*([A-Za-z][^\n]{0,40})",
                                 text, re.M):
                idx = int(m.group(1))
                if idx in found or idx > 9:
                    continue
                # 该款的正文：从标题后到下一个同章条款号之前
                start = m.end()
                nxt = re.search(r"^\s*" + re.escape(key) + r"\.\d+\.", text[start:], re.M)
                end = start + nxt.start() if nxt else len(text)
                body = re.sub(r"\s+", " ", text[start:end]).strip()
                heading = re.sub(r"\s+", " ", m.group(2)).strip()
                found[idx] = (pno, heading, body)
        if found:
            out[key] = found
    return out


def c_aspect_for(surface: str | None) -> str | None:
    if not surface:
        return None
    return SURFACE_TO_R48_ASPECT.get(surface)


def main() -> int:
    q = json.load(io.open(ROOT / "data" / "qualitative-diff.json", encoding="utf-8"))
    r48 = json.load(io.open(ROOT / "data" / "r48-chapters.json", encoding="utf-8"))["map"]
    adj_path = ROOT / "data" / "qualitative-adjudications.json"
    adjudications: dict[str, dict] = {}
    if adj_path.exists():
        adjudications = json.load(io.open(adj_path, encoding="utf-8")).get("entries") or {}

    # 装置 → R48 §6.x
    device_to_r48: dict[str, dict] = {}
    for v in r48.values():
        gb_name = str(v.get("gbName") or "")
        if v.get("r48") and re.match(r"^6\.\d+$", str(v.get("r48"))):
            device_to_r48[gb_name] = v

    c_aspects = extract_c_aspects()
    print(f"C 侧：抽到 {len(c_aspects)} 个装置的条款块", file=sys.stderr)

    entries = []
    for p in q["pairs"]:
        device = p.get("device") or ""
        label = (p.get("label") or "").strip()
        surface = GB_ASPECT_TO_SURFACE.get(label)
        r = classify(p.get("aText", ""), p.get("bText", ""), label)
        key = f"{device}|{label or p.get('bClause','')}"
        e = {
            "key": key,
            "device": device,
            "aspect": label,
            "surface": surface or "",
            "a": {"clause": p.get("aClause", ""), "page": p.get("aPage", ""),
                  "text": p.get("aText", "")},
            "b": {"clause": p.get("bClause", ""), "page": p.get("bPage", ""),
                  "text": p.get("bText", "")},
            "verdict": r["verdict"],
            "basis": r["basis"],
            "similarity": round(r["similarity"], 4),
            "segments": r["segments"][:8],
            "adjudicated": False,
        }
        # C 侧
        dv = device_to_r48.get(device)
        aspect = c_aspect_for(surface)
        if dv and aspect:
            idx = R48_ASPECT_ORDER.index(aspect) + 1
            blk = c_aspects.get(str(dv["r48"]), {}).get(idx)
            if blk:
                e["c"] = {"clause": f"{dv['r48']}.{idx}", "page": blk[0],
                          "heading": blk[1], "text": blk[2][:1200],
                          "device": dv.get("r48Name", "")}
        ad = adjudications.get(key)
        if ad:
            e["verdict"] = ad.get("verdict", e["verdict"])
            e["basis"] = ad.get("basis", e["basis"])
            e["adjudicated"] = True
            if ad.get("impact"):
                e["impact"] = ad["impact"]
        entries.append(e)

    for u in (q.get("unpaired") or []):
        device = u.get("device") or ""
        label = (u.get("label") or "").strip()
        surface = GB_ASPECT_TO_SURFACE.get(label)
        e = {
            "key": f"{device}|{label or u.get('bClause','')}|不可对读",
            "device": device,
            "aspect": label,
            "surface": surface or "",
            "a": {"clause": u.get("aClause", ""), "page": u.get("aPage", ""),
                  "text": u.get("aText", "")},
            "b": {"clause": u.get("bClause", ""), "page": u.get("bPage", ""),
                  "text": u.get("bText", "")},
            "verdict": "不可直接对读",
            "basis": "两版的条款编号体系不对读（装置/款不同），不并排 —— 见附录 H.4",
            "similarity": 0.0,
            "segments": [],
            "adjudicated": False,
        }
        dv = device_to_r48.get(device)
        aspect = c_aspect_for(surface)
        if dv and aspect:
            idx = R48_ASPECT_ORDER.index(aspect) + 1
            blk = c_aspects.get(str(dv["r48"]), {}).get(idx)
            if blk:
                e["c"] = {"clause": f"{dv['r48']}.{idx}", "page": blk[0],
                          "heading": blk[1], "text": blk[2][:1200],
                          "device": dv.get("r48Name", "")}
        entries.append(e)

    counts = Counter(e["verdict"] for e in entries)
    surface_counts = Counter(e["surface"] or "（无固定对应面）" for e in entries)
    payload = {
        "_meta": {
            "purpose": "按义务面建立的全量定性义务台账（客户 DR-013）",
            "unit": "（装置 × 义务面）一条",
            "sources": {
                "ab": "data/qualitative-diff.json（附录 H 的配对结果，已逐条回原文验过）",
                "c": "C 版源 PDF 的条款块（§6.x.N）+ data/r48-chapters.json 的装置对应",
                "adjudication": "data/qualitative-adjudications.json（人工裁定，带理由）",
            },
            "verdictCounts": dict(counts.most_common()),
            "surfaceCounts": dict(surface_counts.most_common()),
            "caveats": [
                "机器判据只覆盖**写法层面**的差异（标点、量词、要求词、同义词、编号重排、限值口径）；"
                "判不出来的一律标「表述不等价·需人工判读」，**不猜**。",
                "人工裁定的结论写在**独立的登记表**里（data/qualitative-adjudications.json），"
                "与机器判据分开 —— 改机器判据不会顺手改人工结论。",
                "C 侧只到**条款级**（§6.x.N + 原文 + 页码），不做逐字对读 —— "
                "GB 与 R48 的条款编号体系不同构，逐号对读会造出假对应。",
            ],
        },
        "entries": entries,
    }
    out = ROOT / "data" / "qualitative-ledger.json"
    with io.open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")

    print(f"wrote {out.relative_to(ROOT)}")
    print(f"  台账单位 {len(entries)} 条")
    for k, n in counts.most_common():
        print(f"    {n:4d}  {k}")
    n_c = sum(1 for e in entries if e.get("c"))
    print(f"  带 C 侧条款的 {n_c} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
