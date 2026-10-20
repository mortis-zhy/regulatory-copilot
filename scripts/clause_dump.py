# -*- coding: utf-8 -*-
"""批量打印若干条款（源 PDF 索引），用于「按条款」写新行。"""
import io, os, sys, importlib.util

spec = importlib.util.spec_from_file_location("cis", os.path.join(os.path.dirname(os.path.abspath(__file__)), "clause_index_src.py"))
cis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cis)

idx = cis.build()
args = sys.argv[1:]
pairs = []
i = 0
while i < len(args):
    if args[i] == "--clause":
        ver = args[i + 1]
        cl = args[i + 2]
        pairs.append((ver, cl))
        i += 3
    else:
        i += 1

for ver, cl in pairs:
    c = idx.get(ver, {}).get(cl)
    print("=" * 90)
    if not c:
        print("【%s %s】没有这个条款" % (ver, cl))
        cand = [k for k in idx.get(ver, {}) if k.startswith(cl.rsplit(".", 1)[0])][:14]
        print("   同前缀：", cand)
        continue
    print("【%s %s】%s   (p%d · %s)" % (ver, cl, c["head"][:60], c["page"], cis.device_of(ver, cl)))
    body = cis.re.sub(r"\s+", " ", c["body"]).strip()
    print(body[:900])
    print("   量值：", ", ".join("%s%s" % (v, u) for v, u, _ in cis.values_in(c["body"]))[:200])
