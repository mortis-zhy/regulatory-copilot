"""
「网站那条路不许改写已入库的产物」—— **已知答案**用例。

## 为什么要有这张用例

sidecar 的 `/verify` 以前会顺手把 `dist/verified-comparison.json` 写一份
（紧凑 JSON，与 `verify_claims.py` 的缩进格式不同）。后果有两条：

  ① 闸门「产物与重跑结果逐字一致」下一次必红 —— 而红的原因看着像
     「产物过期了」，其实只是**格式不同**。真过期时没人查，假过期时
     所有人都会去重算一遍，浪费时间且掩盖真问题。
  ② 更要命的是**来源不同**：网站那条路用的抽取结果与命令行那套
     不是同一份，写进去的那份未必是核验过的那份 ——
     而「入库产物 = 已核验的事实」正是整个项目地基。

所以：**入库的核验产物只能由 `python verify_claims.py` 写。**
网站那条路要写，只能写缓存（gitignore 里的 sidecar-cache）。

## 这张用例断言什么

跑一遍网站那条路（sidecar 的 `/verify`），然后比对**入库产物的 sha256**：
一个字节都不能变。

跑：python scripts/test_no_side_effects.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 入库的核验产物 —— 只有 verify_claims.py 能写它们。
TRACKED = [
    "dist/verified-comparison.json",
    "dist/facts.json",
    "dist/mineru-v4-data.json",
]


def digest(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        return "<missing>"
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main_run() -> int:
    # 让 verify_claims 即便走到了写盘那一步，也只写临时目录。
    os.environ.setdefault("VERIFY_CLAIMS_OUT_DIR", str(ROOT / "tmp" / ".verify-sidefx"))

    before = {rel: digest(rel) for rel in TRACKED}

    sys.path.insert(0, str(ROOT / "python_service"))
    import main  # noqa: E402  (sidecar 本体)

    # 走网站那条路：sidecar 的 /verify。
    out = main.verify_endpoint({})
    assert isinstance(out, dict) and out.get("numericChanges") is not None, \
        "sidecar /verify did not return the verified-comparison shape"

    after = {rel: digest(rel) for rel in TRACKED}
    changed = [rel for rel in TRACKED if before[rel] != after[rel]]

    if changed:
        print("  [FAIL] the web path rewrote tracked artifacts: " + ", ".join(changed))
        for rel in changed:
            print("         before %s" % before[rel][:16])
            print("         after  %s" % after[rel][:16])
        return 1

    print("  [OK] sidecar /verify left every tracked artifact byte-identical (%d files)"
          % len(TRACKED))

    # 源码级：sidecar 不许再把入库产物当缓存写。
    src = (ROOT / "python_service" / "main.py").read_text(encoding="utf-8")
    bad = []
    for rel in TRACKED:
        name = Path(rel).name
        for line in src.splitlines():
            if name in line and ("write_text" in line or "json.dump" in line):
                if "CACHE_DIR" not in line:
                    bad.append(line.strip())
    if bad:
        print("  [FAIL] main.py writes a tracked artifact outside the cache dir:")
        for line in bad:
            print("         " + line)
        return 1
    print("  [OK] main.py writes tracked-artifact names only under CACHE_DIR")
    return 0


if __name__ == "__main__":
    sys.exit(main_run())
