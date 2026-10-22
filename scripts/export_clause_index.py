# -*- coding: utf-8 -*-
"""把条款索引导出成 JSON，给 agent 的工具用。

为什么需要
----------
`lookup_clause` 工具要能回答「B §5.2.4.2 的原文是什么、在第几页」。
条款索引在 **python** 里（`scripts/clause_split.py` 的 `split_clauses`），
而 agent 的工具是 **TS** —— 直接 import 不了。

导出成 `data/clause-index.json`：
  · 键 = 版本代号 → 条款号 → {page, head, body}
  · **现算**（跑一次 python 就重新生成），不是手写
  · 闸门 `scripts/verify.mjs` 里有一条检查它**不与条款索引脱节**
    （条款切分器改了而这份没重生成 → 闸门红）

条款号在 PDF 文本层里常常被拆成多行（「5.\\n2.\\n4.\\n2」），
所以不能用简单搜索从 PDF 里找 —— python 的 `clause_starts` 就是在处理这个。
这也是为什么这份数据要由 python 生成而不是 TS 里现搜。

用法： python scripts/export_clause_index.py [--check]
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "clause-index.json")

# Windows 控制台默认 GBK —— 闸门会把 stdout 直接读进断言，编码错一个字符就是假失败
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))


def build():
    docs = cs.pick_docs()
    out = {"_sourcePdfs": {}, "_clauses": {}}
    for v in cs.ordered_versions(docs):
        idx = cs.split_clauses(docs[v])
        out["_clauses"][v] = {
            k: {
                "page": int(o.get("page") or 0),
                "head": (o.get("head") or "")[:200],
                "body": (o.get("body") or "")[:1200],
            }
            for k, o in idx.items()
        }
        # **版本 → 源 PDF 的映射**必须由 python 给 ——
        # TS 侧不知道哪份 uploaded-docs/*.pdf 是哪一版
        # （按文件名猜会让三个版本都读同一份文件，agent 的回源核实就全错了）。
        # python 的 pick_docs 用**内容指纹**认版本（VERSION_FINGERPRINTS），
        # 不靠页数 —— GB 4785 草案与 2019 版封面几乎相同，只看第一页分不出来。
        out["_sourcePdfs"][v] = {
            "file": os.path.basename(docs[v]),
            "absPath": docs[v],
            "sha256": _sha256(docs[v]),
        }
    return out


def _sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    data = build()
    if "--check" in sys.argv:
        try:
            old = json.load(io.open(OUT_PATH, encoding="utf-8"))
        except Exception as e:
            print("读不到 %s：%s" % (OUT_PATH, e))
            return 1
        a = json.dumps(data, ensure_ascii=False, sort_keys=True)
        b = json.dumps(old, ensure_ascii=False, sort_keys=True)
        if a != b:
            print("条款索引已过期：跑一次 python scripts/export_clause_index.py 重新生成。")
            return 1
        print("条款索引与现算一致：%s" % {k: len(v) for k, v in data.get("_clauses", {}).items()})
        return 0
    io.open(OUT_PATH, "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    print("已写出 %s：%s" % (OUT_PATH, {k: len(v) for k, v in data.get("_clauses", {}).items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
