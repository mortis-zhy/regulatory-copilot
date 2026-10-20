# -*- coding: utf-8 -*-
"""修 JSON 里非法转义：把落单的 \\X（X 不是合法 JSON 转义）补成 \\\\X。

编辑工具在传参时会把某些反斜杠吃掉，写出来的正则就成了 \\d / \\S 这种非法转义。
这个脚本只做一件事：扫描原始文本，把非法转义补齐，然后校验 JSON 合法。
"""
import io, json, sys

P = "data/parameter-specs.json"
s = io.open(P, encoding="utf-8").read()

OK = set('"\\/bfnrtu')
out = []
i = 0
fixed = []
while i < len(s):
    c = s[i]
    if c == "\\" and i + 1 < len(s):
        nxt = s[i + 1]
        if nxt in OK:
            out.append(c)
            out.append(nxt)
            i += 2
            continue
        # 落单的反斜杠：补一个
        line = s.count("\n", 0, i) + 1
        fixed.append((line, nxt))
        out.append("\\\\")
        out.append(nxt)
        i += 2
        continue
    out.append(c)
    i += 1

s2 = "".join(out)
if fixed:
    io.open(P, "w", encoding="utf-8", newline="").write(s2)
for line, ch in fixed:
    print("  补转义：第 %d 行  \\%s" % (line, ch))
print("共补 %d 处" % len(fixed))
json.load(io.open(P, encoding="utf-8"))
print("JSON OK")
