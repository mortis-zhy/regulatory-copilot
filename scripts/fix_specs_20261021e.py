# -*- coding: utf-8 -*-
"""2026-10-21 修 AFS 自适应模式那几行的 absent 说明（**说法不准，等于给了个错结论**）。

发现：核 absent 说明时翻 A 草案第 5.3 章，发现一句关键的话 ——

    A §5.3.7.4.2（p33）「车辆近光各自适应模式应满足 **GB4599** 中自适应模式型式试验
    的要求，**开启的条件应至少满足对应的速度要求**。制造商应提供各自适应模式开启的
    附加条件，并在5.3.9.2.2 的路试时，使用检测机构认可的方法，证明其功能开启的有效性。」

于是：草案**没有**取消 E 模式 / V 模式，**是把模式清单和它们的车速门槛整体转给了
GB 4599**。原来的 absent 说明写的是「草案全文无『E 信号』『数据集 E1』… 草案无 E 级
近光模式」—— 字面没错（整册检索 0 次），但**读者会读成「2026 草案把 E 模式取消了」**。

这正是本项目最贵的那类错：**把「这里没写」写成「这条要求没了」**。
要查 E 模式的车速门槛，应该去 **GB 4599**，不是去 GB 4785 草案里找。

改法：这几行的 absent 说明统一补上「转引 GB 4599」这一层，
并把「属版本间的体系差异」改成「**要求没取消，是转引**」。

跑法： python scripts/fix_specs_20261021e.py [--check] [--write]
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

_s = importlib.util.spec_from_file_location("tp", os.path.join(ROOT, "scripts", "try_pattern.py"))
tp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(tp)

DELEGATE = (
    "**要求没有取消，是转引。** A §5.3.7.4.2（p33）：「车辆近光各自适应模式应满足"
    "**GB4599** 中自适应模式型式试验的要求，**开启的条件应至少满足对应的速度要求**。"
    "制造商应提供各自适应模式开启的附加条件…」"
    "—— 草案把**模式清单和各自的车速门槛整体转给了 GB 4599**，"
    "GB 4785 草案自身不再列这些模式与数字（整册检索「E 信号」「数据集 E1」「V 级」均 0 次）。"
    "**要查这个车速门槛，去 GB 4599，不是说 2026 草案取消了这几档。**"
)

# 每行各自的补充说明
NOTES = {
    "vLevelActivation.speed": (
        "「V 级近光模式」是 GB 4785-2019 §5.22（AFS）的分级概念"
        "（2019 §5.22.7.4.2：V 级近光模式激活条件，车速未超过 60km/h）。"
        "GB 4785 草案全文无「V 级」（整册检索 0 次）—— 草案改用 §5.3 的 AFS 体系，"
        "不再自己列 V 级。" + DELEGATE
    ),
    "afs.vModeUrbanSpeedMax": (
        "GB 4785 草案全文无「V 级」近光模式的分档与车速门槛。" + DELEGATE
    ),
    "afs.vModeSpeedMax": (
        "GB 4785 草案全文无「V 级」近光模式的分档与车速门槛。" + DELEGATE
    ),
    "afs.emodeMotorwaySpeed": (
        "GB 4785 草案全文无「E 信号」「数据集 E1」字样（整册检索 0 次）—— "
        "GB 4785-2019（§5.22.7.4.3，车速超过 110km/h 适用 E 信号）与 "
        "R48（§6.22.7.4.3）都有这一档。" + DELEGATE
    ),
    "afs.emodeE1Speed": (
        "GB 4785 草案全文无「数据集 E1」字样（整册检索 0 次）。" + DELEGATE
    ),
    "afs.emodeE2Speed": (
        "GB 4785 草案全文无「数据集 E2」字样（整册检索 0 次）。" + DELEGATE
    ),
    "afs.emodeE3Speed": (
        "GB 4785 草案全文无「数据集 E3」字样（整册检索 0 次）。" + DELEGATE
    ),
    "afs.wModeWiperDuration": (
        "GB 4785 草案全文无「W 级」近光模式及其雨刮联动时长门槛。" + DELEGATE
    ),
}


def selfcheck():
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    bad = 0
    for sid, note in NOTES.items():
        s = by_id.get(sid)
        if s is None:
            print("  !! 找不到行：%s" % sid)
            bad += 1
            continue
        cur = (s.get("absent") or {}).get("A")
        if not cur:
            print("  !! %s 没有 A 的 absent 说明" % sid)
            bad += 1
            continue
        if "GB4599" in cur:
            print("  · %-34s 已经写过了" % sid)
            continue
        print("  ✓ %-34s 原说明 %d 字 → 新 %d 字" % (sid, len(cur), len(note)))
    # 顺带确认 A 原文真的有那句转引（否则别写这条说明）
    cs = _load_cs()
    docs = cs.pick_docs()
    blob = "\n".join("\n".join(ls) for p, ls in cs.doc_lines(docs["A"]))
    for probe in ("GB4599", "各自适应模式开启的附加条件", "应满足"):
        if probe.replace(" ", "") not in blob.replace(" ", ""):
            print("  !! A 原文里找不到「%s」—— 别写转引这条说明" % probe)
            bad += 1
    return bad


def _load_cs():
    s = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


def write():
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    n = 0
    for sid, note in NOTES.items():
        s = by_id.get(sid)
        if s is None:
            continue
        s.setdefault("absent", {})["A"] = note
        n += 1
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("改了 %d 行说明，总行数 %d" % (n, len(doc["specs"])))


if __name__ == "__main__":
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没过，先别写。" % bad)
            sys.exit(1)
        write()
    else:
        sys.exit(1 if selfcheck() else 0)
