# -*- coding: utf-8 -*-
"""给附录 F 加第 5 组：**前雾灯随装载变化的倾斜度范围**（按安装高度 h 分档）。

A 附录J.1.3.2（生产一致性检验要求）与 C Annex 9 §1.3.2 给的是同一张分档表：
    h ≤ 0.8 : -0.7% ~ -3.3%
    h ＞ 0.8 : -1.2% ~ -3.8%
B 没有这一条（GB 4785-2019 没有「生产一致性检验」附录）。

**引文从源 PDF 的文本层里原样截取**，不手打 —— 手打必错字符
（「～」「＞」和 C 那个写成逗号的「0,8」都是坑）。

跑法： python scripts/add_appendix_f_group5.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, "data", "appendix-tables.json")

_s = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(_s)
_s.loader.exec_module(cs)


def grab(v, needle, before=0, after=320):
    """从源 PDF 文本层里原样截一段。"""
    docs = cs.pick_docs()
    for p, lines in cs.doc_lines(docs[v]):
        t = re.sub(r"\s+", " ", " ".join(lines))
        i = t.find(needle)
        if i >= 0:
            return p, t[max(0, i - before):i + after].strip()
    return 0, ""


def main():
    a_page, a_quote = grab("A", "对于任一单侧总光通量大于2000lm的前雾灯", 0, 130)
    c_page, c_quote = grab("C", "minimum vertical inclination and", 150, 200)
    if not a_quote or not c_quote:
        print("引文没截到：A=%r C=%r" % (a_quote[:40], c_quote[:40]))
        return 1
    print("A p%d 引文：%s" % (a_page, a_quote))
    print("C p%d 引文：%s" % (c_page, c_quote))

    spec = json.load(io.open(TABLES, encoding="utf-8"))
    groups = spec.setdefault("groups", [])
    title = "前雾灯随装载变化的倾斜度范围（按安装高度 h 分档）"
    groups = [g for g in groups if g.get("title") != title]
    groups.append({
        "title": title,
        "note": "**为什么这张表不进第 12 章的标量矩阵**：限值按安装高度 h 分两档"
                "（≤0.8 / ＞0.8），档内是「最小垂直倾角 ~ 最大垂直倾角」一个**区间**，"
                "压成一行数字就丢掉「哪个高度对应哪一档」。"
                "A 写在附录J（生产一致性检验要求），C 写在 Annex 9；"
                "**GB 4785-2019 没有这一条**（它没有「生产一致性检验」附录）。"
                "注意这组数与附录 F 第 2 组（前雾灯**初始**下倾度）不是同一回事 ——"
                "这里是**随装载变化**的范围（-0.7~-3.3 / -1.2~-3.8），"
                "那里是初始照准范围（-1.0~-3.0 / -1.5~-2.0）。",
        "versions": {
            "A": {
                "clause": "J.1.3.2（附录J）",
                "page": a_page,
                "quote": a_quote,
                "rows": [
                    ["安装高度 h", "最小垂直倾角", "最大垂直倾角"],
                    ["h ≤ 0.8", "-0.7%", "-3.3%"],
                    ["h ＞ 0.8", "-1.2%", "-3.8%"]
                ],
                "extra": "A 的同一条还规定「近光灯随装载变化的倾斜度范围，应符合表7」"
                         "（表7 见附录 F 第 1 组）。"
            },
            "B": {
                "clause": "无对应条款",
                "page": 0,
                "quote": "",
                "rows": [["GB 4785-2019 没有「生产一致性检验」附录，也就没有这一组随装载变化的范围"]],
                "extra": "B 的近光/前雾灯下倾度限值在正文 §5.2.6.1.2 / §5.3.6.1.2（见附录 F 第 1、2 组），"
                         "但没有「随装载变化」的这一档范围。"
            },
            "C": {
                "clause": "Annex 9 §1.3.2",
                "page": c_page,
                "quote": c_quote,
                "rows": [
                    ["Mounting height h", "Minimum vertical inclination", "Maximum vertical inclination"],
                    ["h < 0.8", "0.7 per cent", "3.3 per cent"],
                    ["h > 0.8", "1.2 per cent", "3.8 per cent"]
                ],
                "extra": "C 的原文把 0.8 写成「0,8」（逗号），照抄。"
            }
        }
    })
    spec["groups"] = groups
    io.open(TABLES, "w", encoding="utf-8", newline="").write(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    print("附录 F 第 %d 组已写入" % len(groups))
    return 0


if __name__ == "__main__":
    sys.exit(main())
