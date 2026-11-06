# -*- coding: utf-8 -*-
"""生成 `data/lamp-color-map.json`：GB 4785 表5「灯具名称–光色」 ↔ UN R48-09 §5.15 的逐行映射。

## 为什么要有这个文件（客户 DR-011）

客户 DR-011 写的是：

> 第 13 章 灯具光色 只做了 A/B 两版，缺 C（UN R48-09）；
> 修改建议：建立人工核验的灯具名称映射并补 A/B/C 表。

C 的光色规定在 **UN R48-09 §5.15（源 PDF 第 29–30 页）**，体例与 GB 表 5 同构，
逐行对齐**做得到**。以前没做，缺的不是能力而是那张人工核过的对照表。

## 三条来源分开，谁也不能顺手改别人的结论

| 来源 | 内容 | 谁负责 |
|---|---|---|
| **C 版源 PDF 的文本块** | 灯名 / 光色 / 页码 / 引文 | **机器逐行抽取**，一个字不改 |
| **GB 版源 PDF 的术语表** | GB 自己给每个灯定的**英文名**（A §3.3 / B §3.9） | **机器抽取** |
| **GB ↔ C 的对应关系** | 「C 说的是哪个灯」 | **人工判定**，写死在本文件里 |

**GB 自己的英文术语表是这张映射的交叉验证**：
GB 4785-2019 前言写明「本标准技术内容参考了欧洲经济委员会 ECE R48 …06 系」，
所以 GB 的术语本来就照着 R48 的写法译的 ——
GB §3.9.29 把「慢行灯」定义成 **manoeuvring lamp**，正是 R48 §5.15 里的
「Manoeuvring lamp」。**若人工配对与 GB 自己的术语打架，说明人工配对错了。**

> 实际就是这么抓到一个错：初版把「慢行灯」判成「C 无对应」，
> 而 GB 自己的术语表写着 manoeuvring lamp —— 人工配对错，已改。

## 坑 1：MinerU 把 §5.15 的表拆成了两块

`dist/mineru-v4-data.json` 里 C 的 §5.15 被拆成「灯名块」和「光色块」，
两者**无法机械配对**（顺序还被改过）。
所以 C 侧**不**从 MinerU 拿，**从源 PDF 拿** —— 源 PDF 的行块是
「灯名行 + 光色行」成对出现的，配对关系没丢。

## 坑 2：源 PDF 里有一行印刷错误

C 版源 PDF 的 §5.15 里，「Rear position lamp: Red」之后**又印了一行**
「Front fog lamp / White or selective yellow」（**没有冒号**），
然后才是「Rear fog lamp: Red」。
已渲染该页图像人工确认：这不是抽取错误，**原文件就是这样印的**。
处理：照录，但标 `duplicateOf`，并在报告与 caveats 里写明 ——
**不因为看着像重复就悄悄删掉一行**（读者回原文会数出 28 行）。

## 坑 3：GB 的条款号在 PDF 里是断开的

源 PDF 里条款号印成「3. 9. 24」三段，术语正文还有「（AFS）」这种全角括注。
正则必须吃下这些断字与括注，否则抽出来的术语表会缺行
（前雾灯那行还夹着一个页眉「GB 4785—XXXX 9」，条款号与灯名之间不是紧邻的）。

## 用法

```bash
python scripts/build_lamp_color_map.py          # 生成 data/lamp-color-map.json
python scripts/verify_lamp_color_map.py         # 核验（闸门会跑）
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF
# 标准声明 —— **唯一读法**（scripts/declaration.py）。
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "scripts"))
from declaration import decl, family, version_doc, version_docs


ROOT = Path(__file__).resolve().parent.parent
C_PDF = ROOT / "uploaded-docs" / "92b2563197df022a.pdf"    # UN R48-09
A_PDF = ROOT / "uploaded-docs" / "2173836fae9f1314.pdf"   # GB 4785 草案 V4.3.5
B_PDF = ROOT / "uploaded-docs" / "f86e6c7367f24de2.pdf"   # GB 4785-2019
CORPUS = ROOT / "dist" / "mineru-v4-data.json"
OUT = ROOT / "data" / "lamp-color-map.json"

# §5.15 在源 PDF 的第 29–30 页（1-based）
C_PAGES = [29, 30]

# ---------------------------------------------------------------- 人工核验的对应表
# GB 灯具名（按 A 版表 5 的写法） → UN R48-09 §5.15 的灯名
#
# 每一条都对着 C 版源 PDF 那一行核过，并且与 **GB 自己的术语表**交叉核对
# （GB 的英文术语若与 C 的灯名逐字相同，说明两边指的是同一个装置）。
# 改这里 = 改人工结论，必须重跑并复核。
PAIRS: list[tuple[str, str]] = [
    ("远光灯", "Main-beam headlamp"),
    ("近光灯", "Dipped-beam headlamp"),
    ("前雾灯", "Front fog lamp"),
    ("倒车灯", "Reversing lamp"),
    ("转向信号灯", "Direction-indicator lamp"),
    ("危险警告信号", "Hazard warning signal"),
    ("制动灯", "Stop lamp"),
    ("紧急制动信号", "Emergency stop signal"),
    ("追尾警告信号", "Rear-end collision alert signal"),
    ("牌照灯", "Rear registration plate lamp"),
    ("前位灯", "Front position lamp"),
    ("后位灯", "Rear position lamp"),
    ("后雾灯", "Rear fog lamp"),
    ("驻车灯", "Parking lamp"),
    ("侧标志灯", "Side-marker lamp"),
    ("示廓灯", "End-outline marker lamp"),
    ("昼间行驶灯", "Daytime running lamp"),
    ("非三角形后回复反射器", "Rear retro-reflector, non-triangular"),
    ("三角形后回复反射器", "Rear retro-reflector, triangular"),
    ("非三角形前回复反射器（即白色或无色回复反射器）", "Front retro-reflector, non-triangular"),
    ("非三角形侧回复反射器", "Side retro-reflector, non-triangular"),
    ("角灯", "Cornering lamp"),
    ("醒目标志", "Conspicuity marking"),
    ("自适应前照明系统（AFS）", "Adaptive front-lighting systems (AFS)"),
    ("慢行灯", "Manoeuvring lamp"),
]

# GB 表5 有、但 C §5.15 光色表里没有的行 —— 逐条写明「为什么没有对应」
GB_ONLY = [
    ("牵引杆挂车标志灯",
     "R48-09 §5.15 的光色表未列该灯具（全表逐行核对，无对应行）"),
    ("ADS标志灯",
     "R48-09 §5.15 的光色表未列该灯具（全表逐行核对，无对应行）；该行只在 A 草案表 5 中存在"),
]

# C §5.15 有、但 GB 表5 没有的行
C_ONLY = [
    ("Exterior courtesy lamp", "GB 表5「灯具名称–光色」未列该行"),
    ("Answer-back signal", "GB 表5「灯具名称–光色」未列该行"),
]

# C 侧光色的中文对照 —— 人工译文，给中文读者看；原文一列仍然保留
ZH = {
    "Main-beam headlamp": "白色",
    "Dipped-beam headlamp": "白色",
    "Front fog lamp": "白色或选择性黄色",
    "Reversing lamp": "白色",
    "Direction-indicator lamp": "琥珀色",
    "Hazard warning signal": "琥珀色",
    "Stop lamp": "红色",
    "Emergency stop signal": "琥珀色或红色",
    "Rear-end collision alert signal": "琥珀色",
    "Rear registration plate lamp": "白色",
    "Front position lamp": "白色",
    "Rear position lamp": "红色",
    "Rear fog lamp": "红色",
    "Parking lamp": "前面白色、后面红色；若与侧转向信号灯或侧标志灯相互结合安装，则为琥珀色",
    "Side-marker lamp": (
        "琥珀色；但最靠后的侧标志灯可以为红色 —— 若其与后位灯、后示廓灯、后雾灯、制动灯"
        "组合或合并安装，或与后回复反射器组合、或与其共用部分发光面时"
    ),
    "End-outline marker lamp": "前面白色、后面红色",
    "Daytime running lamp": "白色",
    "Rear retro-reflector, non-triangular": "红色",
    "Rear retro-reflector, triangular": "红色",
    "Front retro-reflector, non-triangular": "与入射光相同",
    "Side retro-reflector, non-triangular": (
        "琥珀色；但最靠后的侧回复反射器可以为红色 —— 若其与后位灯、后示廓灯、后雾灯、制动灯、"
        "最靠后的红色侧标志灯或后回复反射器（非三角形）组合，或与其共用部分发光面时"
    ),
    "Cornering lamp": "白色",
    "Conspicuity marking": "前面白色；侧面白色或黄色；后面红色或黄色",
    "Adaptive front-lighting systems (AFS)": "白色",
    "Exterior courtesy lamp": "白色；此外，按所用具体灯具的个别规定执行",
    "Manoeuvring lamp": "白色",
    "Answer-back signal": "按所用应答信号灯的个别规定执行",
}

# 人工判定的对应关系备注（只写**有区别**的那些，避免表格变成散文）
PAIR_NOTES = {
    "醒目标志":
        "对应关系为**部分对应**：GB 醒目标志分「车身反光标识」与「车辆尾部标志板」两项，"
        "C 的 Conspicuity marking 按前/侧/后三个方位给光色，两边的分法不同，不能逐项等同；"
        "另外 GB 两版本身也不同（A 的车身反光标识含**橙色**，B 不含）",
    "非三角形前回复反射器（即白色或无色回复反射器）":
        "C 的脚注 8 写「Also known as white or colourless retro-reflector」，与 GB 括注同义",
    "驻车灯":
        "C 的 Parking lamp 同样带「与侧转向信号灯/侧标志灯结合则为琥珀色」的例外，"
        "与 GB 表述结构一致",
    "侧标志灯":
        "C 与 GB 的「最靠后可为红色」例外条件措辞不同（GB 另列与后位灯/后示廓灯/后雾灯/制动灯"
        "组合等），两边文字不完全对应",
    "非三角形侧回复反射器":
        "C 与 GB 的「最靠后可为红色」例外条件措辞不同（同上）",
    "牌照灯":
        "GB 表5 的行名是「牌照灯」，而 GB 术语表 §3.9.11 定义的名称是"
        "「后牌照板照明装置 rear-registration plate illuminating device」，"
        "与 R48 的 rear registration plate lamp **不是同一个词形**（device vs lamp），"
        "指同一个装置 —— 机器逐字核对在这里判为「人工确认」",
    "慢行灯":
        "GB 术语表把「慢行灯」的英文名定为 **manoeuvring lamp**（A §3.3.21 / B §3.9.29），"
        "与 R48 的 Manoeuvring lamp 同名同义 —— 这一行**不是**靠人工猜的",
    "追尾警告信号":
        "GB 术语表把「追尾警告信号」的英文名定为 **rear-end collision alert signal（RECAS）**"
        "（A §3.1.32.3 / B §3.9.30），与 R48 §2.6.3 同名 —— 这一行**不是**靠人工猜的",
    "非三角形后回复反射器":
        "GB 术语表只定义了总称「回复反射器 retro-reflector」（B §3.9.14 / A §3.3.10），"
        "细分项（前/后/侧 × 三角形/非三角形）没有单独术语 —— 这一行的对应靠装置名称本身",
    "三角形后回复反射器":
        "GB 术语表只定义了总称「回复反射器 retro-reflector」（B §3.9.14 / A §3.3.10），"
        "细分项（前/后/侧 × 三角形/非三角形）没有单独术语 —— 这一行的对应靠装置名称本身",
    "非三角形前回复反射器（即白色或无色回复反射器）":
        "GB 术语表只定义了总称「回复反射器 retro-reflector」（B §3.9.14 / A §3.3.10），"
        "细分项（前/后/侧 × 三角形/非三角形）没有单独术语 —— 这一行的对应靠装置名称本身",
    "非三角形侧回复反射器":
        "GB 术语表只定义了总称「回复反射器 retro-reflector」（B §3.9.14 / A §3.3.10），"
        "细分项（前/后/侧 × 三角形/非三角形）没有单独术语 —— 这一行的对应靠装置名称本身",
}

# 源 PDF 里「灯名行没有冒号」的唯一一处 —— 照录，但标成重复行
NO_COLON_NAMES = {"Front fog lamp"}

# GB 术语表 → 装置名，用于人工配对的交叉核对（机器判定）
TERM_RE = re.compile(
    r"([一-鿿]{2,14}(?:（[A-Za-z]{1,12}）)?)\s*"
    r"([A-Za-z][A-Za-z0-9()（）\-;,\. ]{2,60}?)\s*(?=[一-鿿])"
)
CLAUSE_RE = re.compile(r"(3\.\s*\d+\s*\.\s*\d+(?:\s*\.\s*\d+)*)\s*$")
JUNK_RE = re.compile(
    r"(3\.\s*\d+\s*\.\s*\d+(?:\s*\.\s*\d+)*)\s*"
    r"[A-Za-z0-9 ——\.\-]{0,30}?\s*"
    r"([一-鿿]{2,14}(?:（[A-Za-z]{1,12}）)?)\s*"
    r"([A-Za-z][A-Za-z0-9()（）\-;,\. ]{2,60}?)\s*(?=[一-鿿])"
)


# ---------------------------------------------------------------- 抽取
def collapse(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def tidy_name(s: str) -> str:
    """去掉 PDF 断字留下的连字符空格：「side- marker」→「side-marker」。"""
    return re.sub(r"-\s+", "-", collapse(s)).strip()


def norm_key(s: str) -> str:
    """比英文术语用的归一化：只留字母数字，小写。"""
    return re.sub(r"[^0-9a-z]", "", (s or "").lower())


def extract_c_rows() -> list[dict]:
    doc = fitz.open(str(C_PDF))
    rows: list[dict] = []
    for pno in C_PAGES:
        page = doc[pno - 1]
        blocks = []
        for b in page.get_text("blocks"):
            x0, y0, x1, y1, txt = b[0], b[1], b[2], b[3], b[4]
            if x0 < 60:            # 页边：页眉/页脚/脚注
                continue
            if y0 < 170 or y0 > 600:
                continue
            blocks.append((y0, x0, txt))
        blocks.sort(key=lambda t: (round(t[0], 1), t[1]))

        cur: dict | None = None
        for _y0, _x0, txt in blocks:
            lines = [l for l in txt.split("\n")]
            non_empty = [(i, l.strip()) for i, l in enumerate(lines) if l.strip()]
            if not non_empty:
                continue
            first = non_empty[0][1]
            # 条款标题块（如「5.15. The colours of the light emitted by the lamps7
            # are the following:」）以 ':' 结尾，但不是灯名行 —— 按条款号判掉
            if re.match(r"^\d+(\.\d+)*\.$", first):
                continue
            # 灯名行判定：以 ':' 结尾的行；或已知无冒号行
            colon_idx = None
            for i, l in non_empty:
                if l.endswith(":"):
                    colon_idx = i
                    break
            is_name = colon_idx is not None or first in NO_COLON_NAMES
            if is_name:
                if cur:
                    rows.append(cur)
                if colon_idx is not None:
                    # 灯名行**原样**保留（含冒号与其前后的空格，如
                    # 「Emergency stop signal :」）—— 引文必须是逐字片段
                    raw_name = " ".join(l for _i, l in non_empty[: colon_idx + 1])
                    name = raw_name.rstrip(" :")
                    rest = [l for _i, l in non_empty[colon_idx + 1:]]
                else:
                    raw_name = first
                    name = first
                    rest = [l for _i, l in non_empty[1:]]
                cur = {
                    "cName": tidy_name(name),
                    "cColour": " ".join(rest).strip(),
                    "cPage": pno,
                    "_noColon": colon_idx is None,
                    "_parts": [collapse(raw_name)] + [collapse(r) for r in rest],
                }
            else:
                if cur is None:
                    continue
                cur["cColour"] = (cur["cColour"] + " " + collapse(txt)).strip()
                cur["_parts"].append(collapse(txt))
        if cur:
            rows.append(cur)
    doc.close()
    return rows


def extract_gb_terms(pdf: Path) -> dict[str, dict]:
    """从 GB 源 PDF 抽术语表：{中文名: {clause, en}}。"""
    doc = fitz.open(str(pdf))
    flat = collapse(" ".join(p.get_text() for p in doc))
    doc.close()
    out: dict[str, dict] = {}
    for m in JUNK_RE.finditer(flat):
        clause = re.sub(r"\s+", "", m.group(1))
        name = m.group(2)
        en = collapse(m.group(3))
        if name in out:
            continue
        out[name] = {"clause": clause, "en": en}
    return out


def read_gb_rows() -> dict[str, list[str]]:
    """从语料里读 A/B 的「灯具名称–光色」表。"""
    data = json.load(io.open(CORPUS, encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for v in ("A", "B"):
        names: list[str] = []
        for t in (data[v].get("tables") or []):
            content = t.get("content") or ""
            if "灯具名称" not in content or "光色" not in content:
                continue
            for line in content.split("\n"):
                if not line.startswith("|"):
                    continue
                cells = [c.strip() for c in line.split("|") if c.strip()]
                if len(cells) < 2:
                    continue
                if cells[0] in ("灯具名称",) or set(cells[0]) <= set("- "):
                    continue
                names.append(cells[0])
            break
        out[v] = names
    return out


def norm_gb(s: str) -> str:
    """与报告里 normRow() 一致的归一化：全角/半角括号、中英文逗号、空白。"""
    return (s or "").replace("（", "(").replace("）", ")").replace("，", ",") \
        .replace("；", ";").replace("、", ",").replace(" ", "")


def split_footnote(colour: str) -> tuple[str, list[str]]:
    """拆掉光色末尾的脚注号：「Identical to incident light8」→「Identical to incident light」。

    只在数字紧跟字母或句点时才算脚注号 —— 免得把「R48」之类的编号当成脚注。
    脚注本身不进光色列（它在正文与附录里另行处理）。
    """
    m = re.search(r"(?<=[A-Za-z.])(\d+)$", colour)
    if not m:
        return colour, []
    return colour[: m.start()].rstrip(), [m.group(1)]


def main() -> int:
    c_rows = extract_c_rows()
    # 同名时以**带冒号**的那一行为准（源文件里另有一行没冒号的重复行）
    by_name: dict[str, dict] = {}
    for r in c_rows:
        if r["cName"] not in by_name or not r.get("_noColon"):
            by_name[r["cName"]] = r
    gb = read_gb_rows()
    terms_a = extract_gb_terms(A_PDF)
    terms_b = extract_gb_terms(B_PDF)

    errs: list[str] = []

    # 0) 每一条引文必须是源 PDF 该页的**逐字**片段（空白归一化后）
    page_text = {}
    doc = fitz.open(str(C_PDF))
    for pno in C_PAGES:
        page_text[pno] = collapse(doc[pno - 1].get_text())
    doc.close()
    for r in c_rows:
        q = collapse(" ".join(r["_parts"]))
        if q not in page_text[r["cPage"]]:
            errs.append(f"引文不是源 PDF 第 {r['cPage']} 页的逐字片段：{q[:60]}…")

    # 1) 人工配对里引用的 C 灯名必须真的抽到了
    for gb_name, c_name in PAIRS:
        if c_name not in by_name:
            errs.append(f"人工配对引用的 C 灯名没抽到：{c_name}（对 {gb_name}）")
        if c_name not in ZH:
            errs.append(f"C 灯名缺中文对照：{c_name}")
    for c_name, _reason in C_ONLY:
        if c_name not in by_name:
            errs.append(f"C 独有清单里的灯名没抽到：{c_name}")

    # 2) C 抽到的每一行都要有归属：人工配对 / C 独有 / 重复行
    claimed = {c for _g, c in PAIRS} | {c for c, _r in C_ONLY}
    dupes = [r for r in c_rows if r.get("_noColon")]
    for r in c_rows:
        if r["cName"] not in claimed and r not in dupes:
            errs.append(f"C 版抽到的行没归属：{r['cName']}（请人工判定是配对还是 C 独有）")

    # 3) GB 侧每一行都要有归属（按归一化后的名字比 —— A/B 的括号写法不同）
    gb_names = {norm_gb(n) for v in ("A", "B") for n in gb[v]}
    mapped_gb = {norm_gb(g) for g, _c in PAIRS} | {norm_gb(g) for g, _r in GB_ONLY}
    for n in sorted(gb_names - mapped_gb):
        errs.append(f"GB 表5 里的行没归属：{n}")

    # 4) 人工配对与 GB 自己的术语表必须对得上（能对上的必须对上）
    #    —— GB 的英文术语照 R48 的写法译，对不上说明人工配对错了
    def gb_term(name: str) -> dict | None:
        """按 GB 灯具名找它的术语（先按表5 的行名，再按术语表里的定义名）。"""
        aliases = {
            "牌照灯": "后牌照板照明装置",
            "ADS标志灯": "自动化驾驶系统标志灯",
        }
        for key in (name, aliases.get(name, name), name.replace("（AFS）", "")):
            t = terms_b.get(key) or terms_a.get(key)
            if t:
                return t
        return None

    term_checks: list[dict] = []
    for gb_name, c_name in PAIRS:
        t = gb_term(gb_name)
        if not t:
            term_checks.append({"gb": gb_name, "cName": c_name, "mode": "none",
                                "clause": "", "en": "", "literal": False})
            continue
        literal = False
        # 比对时允许：① 去掉 C 灯名末尾的括注（AFS）；
        #            ② 单复数差异（systems / system）。
        # 这两种是**写法**差异，不是装置差异。
        c_base = re.sub(r"\s*\([^)]*\)\s*$", "", c_name)
        cands = {norm_key(c_name), norm_key(c_base)}
        cands |= {re.sub(r"s$", "", x) for x in list(cands)}
        gb_norm = norm_key(t["en"])
        literal = any(c and c in gb_norm for c in cands)
        term_checks.append({"gb": gb_name, "cName": c_name,
                            "mode": "literal" if literal else "manual",
                            "clause": t["clause"], "en": t["en"], "literal": literal})
        if not literal and gb_name not in PAIR_NOTES:
            errs.append(
                f"GB 术语表与人工配对不一致，且该行没有说明：{gb_name} "
                f"（GB {t['clause']} 的英文术语是「{t['en']}」，C 的灯名是「{c_name}」）"
            )

    if errs:
        print("映射表生成失败：")
        for e in errs:
            print("  -", e)
        return 1

    # ---- 组装输出
    def quote_of(r: dict) -> str:
        return collapse(" ".join(r["_parts"]))

    term_by_gb = {t["gb"]: t for t in term_checks}

    rows_out = []
    for gb_name, c_name in PAIRS:
        r = by_name[c_name]
        raw_colour = collapse(r["cColour"])
        clean, notes = split_footnote(raw_colour)
        tc = term_by_gb[gb_name]
        rows_out.append({
            "gb": gb_name,
            "cName": r["cName"],
            "cColour": raw_colour,
            "cColourClean": tidy_name(clean),
            "cFootnotes": notes,
            "cColourZh": ZH[c_name],
            "cPage": r["cPage"],
            "cQuote": quote_of(r),
            "gbTerm": {
                "clause": tc["clause"],
                "en": tc["en"],
                "mode": tc["mode"],
            },
            "note": PAIR_NOTES.get(gb_name, ""),
        })

    gb_only_out = []
    for gb_name, reason in GB_ONLY:
        t = gb_term(gb_name)
        gb_only_out.append({
            "gb": gb_name,
            "reason": reason,
            "inA": any(norm_gb(gb_name) == norm_gb(x) for x in gb["A"]),
            "inB": any(norm_gb(gb_name) == norm_gb(x) for x in gb["B"]),
            "gbTerm": {"clause": t["clause"], "en": t["en"]} if t else None,
        })

    c_only_out = []
    for c_name, reason in C_ONLY:
        r = by_name[c_name]
        raw_colour = collapse(r["cColour"])
        clean, notes = split_footnote(raw_colour)
        c_only_out.append({
            "cName": r["cName"],
            "cColour": raw_colour,
            "cColourClean": tidy_name(clean),
            "cFootnotes": notes,
            "cColourZh": ZH[c_name],
            "cPage": r["cPage"],
            "cQuote": quote_of(r),
            "reason": reason,
        })

    anomalies = []
    for r in dupes:
        anomalies.append({
            "kind": "duplicate-row-in-source",
            "cName": r["cName"],
            "cPage": r["cPage"],
            "cQuote": quote_of(r),
            "explanation":
                "源 PDF 的 §5.15 里，「Rear position lamp: Red」之后又印了一行"
                "「Front fog lamp / White or selective yellow」（**该行没有冒号**），"
                "随后才是「Rear fog lamp: Red」。已渲染该页图像人工确认："
                "这是**原文件如此**，不是抽取错误。照录并标出，不静默删除 —— "
                "读者回原文数行数会对得上。",
        })

    n_literal = sum(1 for t in term_checks if t["mode"] == "literal")
    n_manual = sum(1 for t in term_checks if t["mode"] == "manual")
    n_none = sum(1 for t in term_checks if t["mode"] == "none")

    payload = {
        "_meta": {
            "purpose": f"{family()} 表5「灯具名称–光色」 ↔ {version_doc('C')} §5.15 的逐行映射（客户 DR-011）",
            "method": (
                "C 侧（灯名/光色/页码/引文）由 `scripts/build_lamp_color_map.py` 从"
                "**源 PDF 的文本块**逐行抽取，一个字不改；"
                "GB 自己的英文术语表（A §3.3 / B §3.9）同样从源 PDF 抽取；"
                "**GB ↔ C 的对应关系是人工判定的**（PAIRS 表），"
                "并与 GB 术语表交叉核对 —— 术语逐字命中记为 literal，"
                "词形不同记为 manual（必须写明理由）。"
            ),
            "cSource": {
                "file": "uploaded-docs/92b2563197df022a.pdf",
                "clause": "5.15",
                "pages": C_PAGES,
                "note": "C 版光色规定在 §5.15（源 PDF 第 29–30 页）",
            },
            "gbSource": {
                "A": f"{version_doc('A')} 表5「灯具名称–光色」；术语表 §3.1 / §3.3",
                "B": f"{version_doc('B')} 4.15 表5「灯具名称–光色」；术语表 §3.9",
            },
            "rowCounts": {
                "A": len(gb["A"]),
                "B": len(gb["B"]),
                "C": len(c_rows),
                "pairs": len(rows_out),
                "gbOnly": len(gb_only_out),
                "cOnly": len(c_only_out),
                "termLiteral": n_literal,
                "termManual": n_manual,
                "termNone": n_none,
                "anomalies": len(anomalies),
            },
            "caveats": [
                "C 的 §5.15 在 MinerU 语料里被拆成「灯名块」和「光色块」两块，**无法机械配对**；"
                "所以 C 侧取自源 PDF 的行块（成对的「灯名行 + 光色行」），不是取自 MinerU。",
                "C 侧光色原文一律保留英文；中文一列是人工译文，只为方便阅读，"
                "**判定依据永远是英文原文**。",
                "C 版 §5.15 的脚注 8（Front retro-reflector 的别称）与脚注 9"
                "（Conspicuity marking 的缔约方选择权）不在光色行内，"
                "在正文与附录里另行处理。",
                "GB 的术语表与 R48 的灯名逐字相同，是**交叉验证**而不是独立来源 —— "
                f"{version_doc('B')} 前言写明其技术内容参考 ECE R48 06 系，术语本就照 R48 译。",
            ],
        },
        "rows": rows_out,
        "gbOnly": gb_only_out,
        "cOnly": c_only_out,
        "anomalies": anomalies,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  A 表5 {len(gb['A'])} 行 · B 表5 {len(gb['B'])} 行 · C §5.15 {len(c_rows)} 行")
    print(f"  配对 {len(rows_out)} 条 · GB 独有 {len(gb_only_out)} 条 · "
          f"C 独有 {len(c_only_out)} 条 · 源文件异常 {len(anomalies)} 条")
    print(f"  GB 术语交叉核对：逐字命中 {n_literal} · 人工确认 {n_manual} · 无术语 {n_none}")
    for t in term_checks:
        if t["mode"] == "manual":
            print(f"    · 人工确认：{t['gb']} ← GB {t['clause']}「{t['en']}」 / C「{t['cName']}」")
        if t["mode"] == "none":
            print(f"    · 无 GB 术语：{t['gb']} ← C「{t['cName']}」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
