# -*- coding: utf-8 -*-
"""`scripts/diff_corrections.py` 与差值判定的**自测**。

为什么要有：清洗器改的是**报告里的数字**。它一旦判错，
「1s~1.5s」会被改成「1s~1.5」（数值被改小），或者把
「500m」当成重复单位删成「500」—— 这种错**不会报错**，
只会安静地改掉法规结论。所以清洗规则必须有**已知答案**的用例。

跑法： python scripts/test_diff_corrections.py
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


dc = _load("dc", os.path.join(ROOT, "scripts", "diff_corrections.py"))

CASES_NORMALIZE = [
    # (输入, 期望输出, 为什么)
    ("（4.0±1.0）HzHz", "（4.0±1.0）Hz", "单位被写了两遍"),
    ("不得超过3ss", "不得超过3s", "单位被写了两遍"),
    ("1500mm（可放宽至2300mm）mm", "1500mm（可放宽至2300mm）", "括号后的单位是重复的"),
    ("2只（成对）只", "2只（成对）", "括号后的单位是重复的"),
    ("（90±30）次/min次/min", "（90±30）次/min", "单位被写了两遍"),
    ("（100±20）km/hkm/h", "（100±20）km/h", "单位被写了两遍"),
    ("各30°度", "各30°", "同一个单位的两种写法（°/度）"),
    ("各灯具每个方向上允差为±3°度", "各灯具每个方向上允差为±3°", "同上"),
    ("-1.5%～-2.0%%", "-1.5%～-2.0%", "百分号被写了两遍"),
    ("1.5s时间内首次熄灭s", "1.5s时间内首次熄灭", "结尾悬空的单位"),
    ("1.5s时间内s", "1.5s时间内", "结尾悬空的单位"),
    ("不大于300ss", "不大于300s", "单位被写了两遍"),
    ("一套。发光单元数量与灯具型式试验时一致套", "一套。发光单元数量与灯具型式试验时一致", "结尾悬空的单位"),
    ("13.5V的5%以上（即约14.175V）V", "13.5V的5%以上（即约14.175V）", "结尾悬空的单位"),
    # --- 下面这些**不许动** ---
    ("1s~1.5s", "1s~1.5s", "区间写法的第二个单位不是重复"),
    ("1200mm", "1200mm", "数字自己的单位"),
    ("不超过3s", "不超过3s", "数字自己的单位"),
    ("500m", "500m", "m 是单位，不能动"),
    ("不大于500mm", "不大于500mm", "只出现一次的单位不能动（500m/500mm 的差别靠更正表，不靠清洗器）"),
    ("两只或四只。对于N3类车辆可以多安装两只远光灯", "两只或四只。对于N3类车辆可以多安装两只远光灯", "汉字数字后面的单位"),
    ("一只或两只(每侧一只)", "一只或两只(每侧一只)", "汉字数字后面的单位"),
    ("离地高度不小于500mm，不大于1200mm", "离地高度不小于500mm，不大于1200mm", "两个数各带自己的单位"),
    ("（4.0±1.0）Hz", "（4.0±1.0）Hz", "只有一个单位"),
]

CASES_RESIDUAL = [
    ("（4.0±1.0）Hz", ""),
    ("1s~1.5s", ""),
    ("1500mm（可放宽至2300mm）", ""),
    ("（4.0±1.0）HzHz", "相邻重复单位 Hz"),
    ("-1.5%～-2.0%%", "重复百分号"),
]


def main():
    fails = []

    for src, want, why in CASES_NORMALIZE:
        got = dc.normalize_value(src)
        if got != want:
            fails.append("normalize_value(%r) = %r，期望 %r（%s）" % (src, got, want, why))

    for src, want in CASES_RESIDUAL:
        got = dc.residual_artifact(src)
        if want == "" and got:
            fails.append("residual_artifact(%r) 报了 %r，期望干净" % (src, got))
        if want and want not in got:
            fails.append("residual_artifact(%r) = %r，期望包含 %r" % (src, got, want))

    # --- 清洗器不许改数字 ---
    for src, want, why in CASES_NORMALIZE:
        got = dc.normalize_value(src)
        import re
        a = re.findall(r"\d+(?:\.\d+)?", src)
        b = re.findall(r"\d+(?:\.\d+)?", got)
        if a != b:
            fails.append("normalize_value(%r) 把数字改了：%s → %s（%s）" % (src, a, b, why))

    # --- 更正表与差值表必须对得上 ---
    diff_path = os.path.join(ROOT, "diff-result.json")
    if os.path.exists(diff_path):
        diff = json.load(io.open(diff_path, encoding="utf-8"))
        rows = diff.get("valueDiffs") or []
        fixed, applied, unmatched, residual = dc.apply_corrections(rows)
        if unmatched:
            fails.append("更正表里有 %d 条对不上 valueDiffs：%s"
                         % (len(unmatched), [c.get("name") for c in unmatched]))
        if residual:
            fails.append("有 %d 处机械噪声没有人工兜底：%s"
                         % (len(residual), [(r[0], r[1]) for r in residual]))
        if len(fixed) != len(rows):
            fails.append("清洗后行数变了：%d → %d" % (len(rows), len(fixed)))

    print("差值清洗自测：%d 条用例" % (len(CASES_NORMALIZE) + len(CASES_RESIDUAL)))
    if fails:
        for f in fails:
            print("  ✗ " + f)
        return 1
    print("全部通过 ✓（数字一个没动、重复单位都清掉了、区间写法没被误伤）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
