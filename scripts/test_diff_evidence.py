# -*- coding: utf-8 -*-
"""差值更正的**取证模型**自测 —— 证明「站不住」的更正确实被挡住。

为什么要有这个
--------------
`scripts/diff_value_check.py` 守的是第 11 章的取值 —— 报告的**决策核心**。
它有三级证据：数字 → 逐字 → 锚点。

但**只测「好的更正能过」是不够的**：一个从不报错的检查器，
和一个没有检查器是同一种东西（这正是 ㉒ 一致性自查页 53 项误报的教训）。
所以这里喂它**已知答案的反例**：每一条都必须是「本该被挡住」的更正，
检查器必须**逐条报出问题**。

跑法： python scripts/test_diff_evidence.py
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


dvc = _load("dvc", os.path.join(ROOT, "scripts", "diff_value_check.py"))

# 反例：(说明, 更正 dict, 取证的一侧)
# 每一行的期望：**必须报出问题**（报不出来 = 检查器有洞）。
BAD_CASES = [
    ("定性取值被改了一个词",
     {"topic": "远光灯", "name": "配备",
      "newValue": "汽车应配备，挂车不应装", "aClause": "5.1.1"},
     "newValue", "A", "aClause", "aTable"),
    ("定性取值被换成了另一条要求",
     {"topic": "牌照灯", "name": "数量",
      "newValue": "两套。发光单元数量与灯具型式试验时一致", "aClause": "5.8.2"},
     "newValue", "A", "aClause", "aTable"),
    ("数字抄错了",
     {"topic": "近光灯", "name": "弯道照明曲率半径",
      "newValue": "不大于500mm", "aClause": "5.2.7.4"},
     "newValue", "A", "aClause", "aTable"),
    ("条款指错了（引到了别的章）",
     {"topic": "远光灯", "name": "配备",
      "newValue": "汽车应配备，挂车不应安装", "aClause": "5.19.1"},
     "newValue", "A", "aClause", "aTable"),
    ("表格页码指错了",
     {"topic": "灯具光色对应表", "name": "醒目标志光色",
      "newValue": "车身反光标识：红色、白色和橙色", "aClause": "表5", "aTable": 18},
     "newValue", "A", "aClause", "aTable"),
    ("B 侧取值不属于所引条款",
     {"topic": "危险警告信号", "name": "指示器",
      "oldValue": "应配备闪烁的接通指示器", "bClause": "5.6.8"},
     "oldValue", "B", "bClause", "bTable"),
    ("条款号写错成不存在的",
     {"topic": "远光灯", "name": "配备",
      "newValue": "汽车应配备，挂车不应安装", "aClause": "99.99.99"},
     "newValue", "A", "aClause", "aTable"),
]

# 正例：这些**必须通过**（检查器不能变成「什么都报错」）。
GOOD_CASES = [
    ("原样引用 A §5.1.1",
     {"topic": "远光灯", "name": "配备",
      "newValue": "汽车应配备，挂车不应安装", "aClause": "5.1.1"},
     "newValue", "A", "aClause", "aTable"),
    ("原样引用 A §5.8.2",
     {"topic": "牌照灯", "name": "数量",
      "newValue": "一套。发光单元数量与灯具型式试验时一致", "aClause": "5.8.2"},
     "newValue", "A", "aClause", "aTable"),
    ("原样引用 B §5.6.8",
     {"topic": "危险警告信号", "name": "指示器",
      "oldValue": "应配备闪烁接通指示器", "bClause": "5.6.8"},
     "oldValue", "B", "bClause", "bTable"),
    ("表格取证（第19页的表5）",
     {"topic": "灯具光色对应表", "name": "醒目标志光色",
      "newValue": "车身反光标识：红色、白色和橙色", "aClause": "表5", "aTable": 19},
     "newValue", "A", "aClause", "aTable"),
]


def main():
    docs = dvc.cs.pick_docs()
    corpus = dvc.load_corpus(docs)
    fails = []
    for desc, corr, side, ver, key, tkey in BAD_CASES:
        problems = dvc.evaluate_side(corr, side, ver, key, tkey, corpus)
        if not problems:
            fails.append("本该被挡住却放过了：%s" % desc)
        else:
            print("  ✓ 挡住了：%s —— %s" % (desc, problems[0][:70]))
    for desc, corr, side, ver, key, tkey in GOOD_CASES:
        problems = dvc.evaluate_side(corr, side, ver, key, tkey, corpus)
        if problems:
            fails.append("本该通过却被挡住：%s —— %s" % (desc, problems[0][:70]))
        else:
            print("  ✓ 放行：%s" % desc)

    # 更正表里的每一条都必须在**两侧**都站得住
    items = dvc.dc.load_corrections()
    for c in items:
        for side, ver, key, tkey in (("newValue", "A", "aClause", "aTable"),
                                     ("oldValue", "B", "bClause", "bTable")):
            if c.get(side) is None:
                continue
            for p in dvc.evaluate_side(c, side, ver, key, tkey, corpus):
                fails.append("更正表里的条目站不住：%s|%s —— %s"
                             % (c.get("topic"), c.get("name"), p))

    print("取证模型自测：%d 条反例 + %d 条正例 + 更正表全量复核"
          % (len(BAD_CASES), len(GOOD_CASES)))
    if fails:
        for f in fails:
            print("  ✗ " + f)
        return 1
    print("全部通过 ✓（该挡的挡住了，该放行的放行了）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
