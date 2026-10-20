# -*- coding: utf-8 -*-
"""往 data/parameter-specs.json 里追加新行（**按条款写出来的第一批**）。

用法：改本文件下面的 NEW_SPECS，然后 python scripts/add_specs.py
"""
import io, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

NEW_SPECS = [
    {
        "id": "brakeLamp.s1s2MinHeight",
        "name": "S1/S2 制动灯最小离地高度",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.7\.4\.2\.1[\s\S]{0,120}?离地高度应不小于\s*(350\s*(?:mm|㎜))", "flags": "i"},
            "B": {"source": r"5\.7\.4\.2\.1[\s\S]{0,120}?离地高\s*度\s*应\s*不\s*小\s*于\s*(350\s*mm)", "flags": "i"},
            "C": {"source": r"6\.7\.4\.2\.1[\s\S]{0,120}?not less than\s*(350\s*mm)", "flags": "i"},
        },
        "why": {
            "A": "条款 5.7.4.2.1 一次给了三个数：**350（不小于）/ 1500（不大于）/ 2100（结构受限可增至）**。上一轮只写了 2100 那一条，另外两个值被整条漏掉 —— 这就是「以参数为单位」的必然结果：一条正则只负责一个数，条款里剩下的数没人管。**按条款写**（一次读完整条款，再拆成三行）就不会漏。",
            "B": "B 的条款号在正文里是「5.7.4.2.1」✓，但正文逐字加空格（「离地高 度 应 不 小 于 350 mm」），汉字之间要 `\\s*`。",
            "C": "R48 §6.7.4.2.1 写「not less than 350 mm nor more than 1,500 mm (2,100 mm …)」—— 千分位要 `1[ ,]500`。",
        },
    },
    {
        "id": "brakeLamp.s1s2MaxHeight",
        "name": "S1/S2 制动灯最大离地高度",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.7\.4\.2\.1[\s\S]{0,120}?不大于\s*(1500\s*(?:mm|㎜))", "flags": "i"},
            "B": {"source": r"5\.7\.4\.2\.1[\s\S]{0,120}?不\s*大\s*于\s*(1500\s*mm)", "flags": "i"},
            "C": {"source": r"6\.7\.4\.2\.1[\s\S]{0,120}?nor more than\s*(1[ ,]500\s*mm)", "flags": "i"},
        },
        "why": {
            "A": "同 brakeLamp.s1s2MinHeight：这三个数在同一条款里，**一起写**才不会漏。",
            "B": "同 A；B 的 1500 前面有空格，捕获组里已经排除了前后的文字。",
            "C": "千分位写法：`1[ ,]500`（R48 写「1,500 mm」）。",
        },
    },
    {
        "id": "drl.innerEdgeGapNarrow",
        "name": "昼间行驶灯两灯内缘间距下限（车宽<1300mm 时可减至）",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.19\.4\.1[\s\S]{0,300}?则该距离可减至为不小于\s*(400\s*(?:mm|㎜))", "flags": "i"},
            "B": {"source": r"5\.19\.4\.1[\s\S]{0,300}?则该距离可减至为不小于\s*(400\s*mm)", "flags": "i"},
            "C": {"source": r"6\.19\.4\.1[\s\S]{0,300}?may be reduced to\s*(400\s*mm)", "flags": "i"},
        },
        "why": {
            "A": "制动灯有同样的「可减至 400mm」（brakeLamp.innerEdgeGapNarrow），**昼间行驶灯这一族当时漏了** —— 因为 400/1300/600 三个数在同一条款里，只写 600 和 1300 时，400 没人认领。条款级清点（scripts/clause_index_src.py）能直接看到漏掉的那一个。",
            "B": "同 A。B 的正文是「若车宽小于1300mm,则该距离可减至为不小于400mm」✓。",
            "C": "R48 §6.19.4.1：「This distance may be reduced to 400 mm where the overall width of the vehicle is less than 1,300 mm.」",
        },
    },
    {
        "id": "courtesyLamp.maxIntensity",
        "name": "礼貌灯（迎宾灯）单灯光强上限（替代验证）",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "A": {"source": "礼貌灯", "flags": "i"},
            "B": {"source": "礼貌灯", "flags": "i"},
            "C": {"source": r"6\.24\.9\.4[\s\S]{0,400}?not more less than\s*(0\.5\s*cd)", "flags": "i"},
        },
        "why": {
            "A": "**GB 4785 草案全文没有「礼貌灯」**（整册检索无命中，目录 5.1–5.24 / 6.x / 7.x 也没有这一章）—— R48 §6.24 是**欧盟独有的**装置类别。留一条「明确检索过、没有」的空值，比什么也不写诚实：读者能看出这是版本差异，不是抽取失败。",
            "B": "同 A：GB 4785-2019 也没有「礼貌灯」这一章（目录 5.1–5.26 无此节）。",
            "C": "R48 §6.24.9.4：「…deemed be satisfactory if the applicant can prove that the luminous intensity of light emitted directly during the observation test described in Annex 14 is not more less than 0.5 cd per lamp.」—— 原文写的是「not more less than」（原文如此），正则照抄。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「礼貌灯」字样（整册检索无命中，目录亦无此章）—— 礼貌灯（exterior courtesy lamp）是 **UN R48 §6.24 独有的装置类别**，GB 4785 两版都没有。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 全文无「礼貌灯」字样（整册检索无命中，目录亦无此章）—— 礼貌灯是 **UN R48 §6.24 独有的装置类别**。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "answerBackSignal.maxFlashFrequency",
        "name": "应答信号闪烁频率上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "Hz",
        "patterns": {
            "A": {"source": "应答信号", "flags": "i"},
            "B": {"source": "应答信号", "flags": "i"},
            "C": {"source": r"6\.27\.7[\s\S]{0,200}?frequency shall not exceed\s*(2\.0\s*Hz)", "flags": "i",
                  "clause": "6.27.7.2"},
        },
        "why": {
            "A": "**GB 4785 草案全文没有「应答信号」**（整册检索无命中，目录 5.1–5.24 / 6.x / 7.x 也没有）—— 应答信号（answer-back signal）是 **UN R48 §6.27 独有**的装置类别（2019 年后的增补件引入）。",
            "B": "同 A：GB 4785-2019 也没有「应答信号」。",
            "C": "R48 §6.27.7.2：「If the answer-back signal flashes, the frequency shall not exceed 2.0 Hz.」**条款号显式写 6.27.7.2**：MinerU 把 §6.27.7 的表格行标签并成了 `| 6.27.7.2.6.27.7.3.6.27.7.4. |`（三行并一行），正则锚不出真条款号；源 PDF 的文本层里 6.27.7.2 是独立的（scripts/clause_index_src.py 可查）。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「应答信号」字样（整册检索无命中，目录亦无此章）—— 应答信号是 **UN R48 §6.27 独有的装置类别**。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 全文无「应答信号」字样（整册检索无命中，目录亦无此章）—— 应答信号是 **UN R48 §6.27 独有的装置类别**。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "answerBackSignal.maxIntensity",
        "name": "应答信号单灯光强上限",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "A": {"source": "应答信号", "flags": "i"},
            "B": {"source": "应答信号", "flags": "i"},
            "C": {"source": r"6\.27\.9[\s\S]{0,300}?does not exceed\s*(700\s*cd)", "flags": "i",
                  "clause": "6.27.9.1"},
        },
        "why": {
            "A": "同 answerBackSignal.maxFlashFrequency：GB 4785 草案没有「应答信号」这一章。",
            "B": "同 A：GB 4785-2019 也没有。",
            "C": "R48 §6.27.9.1：「The answer-back signal shall be provided by approved lighting and light-signalling devices and exterior courtesy lamps where in all these cases, the maximum luminous intensity per lamp does not exceed 700 cd on or above the HH line.」**条款号显式写 6.27.9.1**：MinerU 把行标签并成了 `| 6.27.9.6.27.9.1. |`（6.27.9 的标题 + 6.27.9.1 的正文并成一行），源 PDF 里两者是分开的。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「应答信号」字样（整册检索无命中，目录亦无此章）—— 应答信号是 **UN R48 §6.27 独有的装置类别**。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 全文无「应答信号」字样（整册检索无命中，目录亦无此章）—— 应答信号是 **UN R48 §6.27 独有的装置类别**。属版本差异，不是抽取失败。",
        },
    },
]


def main():
    s = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(s)
    have = {x["id"] for x in data["specs"]}
    add = [x for x in NEW_SPECS if x["id"] not in have]
    if not add:
        print("没有新行要加（都已存在）")
        return
    # 追加到数组末尾，缩进与文件里现有条目一致（4 空格起）
    block = []
    for i, spec in enumerate(add):
        body = json.dumps(spec, ensure_ascii=False, indent=2)
        body = "\n".join(("    " + ln) if ln else ln for ln in body.split("\n"))
        body = body.replace('"flags": "i"', '"flags": "i"')
        block.append(body)
    text = ",\n".join(block)
    # 插到最后的 "  ]" 之前
    idx = s.rstrip().rfind("]")
    head = s[:idx].rstrip()
    if not head.endswith("},"):
        head += ""
    s2 = head + ",\n" + text + "\n  ]\n}\n"
    json.loads(s2)
    io.open(SPEC, "w", encoding="utf-8", newline="").write(s2)
    print("已加 %d 行：%s" % (len(add), "、".join(x["id"] for x in add)))
    print("总行数：%d" % (len(json.loads(s2)["specs"])))


if __name__ == "__main__":
    main()
