# -*- coding: utf-8 -*-
"""校准「该版无此规定」的说明：只在**抽取正则真的匹配上了**时才删。

交付闸门的硬规则是：某版本既有 pattern 又有 absent，而 pattern **匹配上了** ——
那就是假的法规结论（一边说有值、一边说没这条），构建直接报错。

但「有 pattern 却匹配不上」是完全正常的用法：比如礼貌灯是 R48 独有的装置族，
A/B 写一条永远匹配不上的正则，再配一句「A/B 整章没有礼貌灯」——
这条说明是有价值的，**不能删**。

所以判据不是「有没有 pattern」，而是「pattern 有没有命中」。

用法： python scripts/fix_absent_conflicts.py [--dry]
"""
import importlib.util, io, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

_s = importlib.util.spec_from_file_location("tp", os.path.join(ROOT, "scripts", "try_pattern.py"))
tp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(tp)


def head_specs():
    """上一次提交里的 spec 表 —— 用来把误删的 absent 说明找回来。"""
    try:
        raw = subprocess.check_output(
            ["git", "show", "HEAD:data/parameter-specs.json"], cwd=ROOT)
        return {s["id"]: s for s in json.loads(raw.decode("utf-8"))["specs"]}
    except Exception as e:
        print("  (读不到 HEAD 版本：%s)" % e)
        return {}


def main():
    dry = "--dry" in sys.argv
    raw = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(raw)
    old = head_specs()
    n_restored = n_removed = 0

    for s in data["specs"]:
        pats = s.get("patterns") or {}
        absent = s.setdefault("absent", {})
        prev = (old.get(s["id"]) or {}).get("absent") or {}
        for ver in list(pats.keys()):
            if ver in absent:
                continue
            # 之前被误删的、且这一版仍然该留着说明的 → 找回来
            if ver in prev:
                absent[ver] = prev[ver]
                n_restored += 1
                print("  恢复 %-40s %s" % (s["id"], ver))
        for ver in list(absent.keys()):
            pat = pats.get(ver)
            if not pat:
                continue
            src = pat if isinstance(pat, str) else pat.get("source", "")
            hit = tp.run(ver, src)
            if hit:
                del absent[ver]
                n_removed += 1
                print("  删掉 %-40s %s —— 正则匹配到了（%s）" % (s["id"], ver, hit["focus"][:40]))
        if not absent:
            del s["absent"]

    print("恢复 %d 条说明，删掉 %d 条假结论%s"
          % (n_restored, n_removed, "（dry-run，未写）" if dry else ""))
    if not dry and (n_restored or n_removed):
        io.open(SPEC, "w", encoding="utf-8", newline="").write(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
