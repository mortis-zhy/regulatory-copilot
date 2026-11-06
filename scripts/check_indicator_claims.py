# -*- coding: utf-8 -*-
"""**声称指标**（`data/indicator-claims.json`）的**校验器**。

用法：

    python scripts/check_indicator_claims.py --check    # 校验（闸门用）

（**没有** `--migrate`：新标准那 9 条是**新内容**（声称值、正则都是新标准的
知识），得**写**出来，不是从旧代码里抽出来 —— 「build」这个角色对下一套标准
没有价值。要重挑这 9 条：直接编辑 `data/indicator-claims.json`，然后跑 `--check`。）

## 这个文件是什么

第 11.4 节那 9 条「**声称方说的值** vs **原文的值**」。
它们原来在 `server/reports/reportV6.ts` 的 `INDICATORS` 常量里 ——
**值与正则都写在代码里**。换一套标准时这 9 条必须重写，
而改代码比改数据危险：改坏了照样跑得起来，只是**说错话**。

## 校验器查什么（--check）

| 查什么 | 为什么 |
|---|---|
| 声称方那 9 条与**核过**那 9 条是**同一批**（id 集合相同） | 两张表各写各的 → 迟早对不上，而「对不上」没人发现 |
| 每条都有 id / 标签 / 单位 / 声称值 / 正则 | 缺一个字段 → 报告那一格**空着**，读者以为是「没有」 |
| 每条正则**编译得过**（源码 + 旗标） | 编译不过 → 抽取时抛错 → 报告缺一格 |
| `absenceNote` 里的槽位都是**认识的** | 槽位拼错 → `fill()` 原样留下 `{standrdFamily}` 在报告里 |

（`--check` 只读不写 —— 检查器顺手把产物修好 = 永远验不出来。）
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLAIMS = os.path.join(ROOT, "data", "indicator-claims.json")
VERDICTS = os.path.join(ROOT, "data", "indicator-verdicts.json")

# `reportMeta.ts` 的 `fill()` 认识的槽位（那几个是标准身份的一部分）
KNOWN_SLOTS = {"standardFamily", "standardFamilyShort"}

REQUIRED = ("id", "label", "unit", "claimOld", "claimNew", "patterns")


def load(p):
    return json.load(io.open(p, encoding="utf-8"))


def check():
    claims = load(CLAIMS)
    rows = claims.get("rows") or []
    errors = []

    if not rows:
        errors.append("data/indicator-claims.json 里一条都没有 —— 第 11.4 节会空着")

    # ① 声称方那批 == 核过的那批
    try:
        verdicts = load(VERDICTS)
        vids = [r.get("id") for r in (verdicts.get("rows") or [])]
    except Exception as e:  # noqa: BLE001
        vids = []
        errors.append("data/indicator-verdicts.json 读不出来：%s" % e)
    cids = [r.get("id") for r in rows]
    if vids and cids != vids:
        errors.append(
            "声称方那批与核过那批**对不上**：\n"
            "      声称：%s\n      核过：%s" % (cids, vids)
        )

    # ②③④ 逐条
    for r in rows:
        rid = r.get("id", "?")
        for f in REQUIRED:
            if f not in r:
                errors.append("指标「%s」缺字段 `%s`" % (rid, f))
        pats = r.get("patterns") or []
        if not pats:
            errors.append("指标「%s」一条正则都没有 —— 报告那一格取不到值" % rid)
        for i, p in enumerate(pats):
            src = str(p.get("source") or "")
            flags = str(p.get("flags") or "")
            if not src:
                errors.append("指标「%s」第 %d 条正则的源码是空的" % (rid, i + 1))
                continue
            f = 0
            for ch in flags:
                if ch == "i":
                    f |= re.IGNORECASE
                elif ch == "m":
                    f |= re.MULTILINE
                elif ch == "s":
                    f |= re.DOTALL
                elif ch in ("g", "u", "y"):
                    pass
                else:
                    errors.append("指标「%s」第 %d 条正则的旗标 `%s` 不认识" % (rid, i + 1, ch))
            try:
                re.compile(src, f)
            except re.error as e:
                errors.append("指标「%s」第 %d 条正则**编译不过**：%s" % (rid, i + 1, e))
        note = str(r.get("absenceNote") or "")
        for slot in re.findall(r"\{(\w+)\}", note):
            if slot not in KNOWN_SLOTS:
                errors.append(
                    "指标「%s」的 `absenceNote` 里有不认识的槽位 {%s} —— "
                    "`fill()` 会原样留下它，报告里就会出现这一串花括号" % (rid, slot)
                )

    if errors:
        print("声称指标台账有 %d 处对不上：" % len(errors))
        for e in errors:
            print("  · " + e)
        raise SystemExit(1)

    print("声称指标 %d 条 · 与核过那批一一对应 · 正则都编译得过 · 槽位都认识" % len(rows))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode == "--check":
        check()
    else:
        raise SystemExit("用法：--check")
