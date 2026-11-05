"""
「认版本不许只靠文件名」—— **已知答案**用例（sidecar 那一侧）。

## 为什么要有这张用例

网站这条链路上认版本原先**只有一条路**：sidecar 按**文件名**正则认。
用户把文件改了名（很普通的事）→ 整个流程在最后一步 400「未匹配任何已支持的标准」，
而**文件内容完全没问题**。

现在有两条路：

    labelSource="content"    —— 调用方**按内容**认出来的（对着语料比相似度）。
                                内容是硬证据，文件名只是线索 → **内容说了算**，
                                文件名不同意就**说出来**，不偷偷改。
    labelSource="positional" —— 调用方只是「按上传顺序」排的（第几个就是第几版）。
                                这种标签没有证据 → **文件名说了算**（原来的行为）。

## 这张用例断言什么

    ① 内容认出来的标签 + 一个毫无意义的名字 → **认得出**（原来这里会 400）；
    ② 同样载荷但按上传顺序 → **就该 400**（旧行为留作对照，
       否则「修了」和「没修」分不开）；
    ③ 内容与文件名**矛盾**时 → 以内容为准，且**说出来**（label_inferred=True）。

跑：python scripts/test_label_source.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python_service"))

import main  # noqa: E402  (sidecar 本体)

FAILURES = 0


def ok(cond: bool, msg: str) -> None:
    global FAILURES
    if cond:
        print("  [OK] " + msg)
    else:
        print("  [FAIL] " + msg)
        FAILURES += 1


def corpus_sources() -> dict:
    """语料里各版的源 PDF（活语料，跟仓库走）。"""
    data = json.loads((ROOT / "dist" / "mineru-v4-data.json").read_text(encoding="utf-8"))
    out = {}
    for ver, doc in data.items():
        sha16 = str(doc.get("sourceSha256", ""))[:16]
        p = ROOT / "uploaded-docs" / (sha16 + ".pdf")
        if sha16 and p.exists():
            out[ver] = p
    return out


def main_run() -> int:
    sources = corpus_sources()
    if len(sources) < 2:
        print("  [FAIL] corpus has fewer than 2 versions with source PDFs")
        return 1

    for ver, path in sorted(sources.items()):
        # ① 内容认出来的标签 + 一个毫无意义的名字 → 认得出
        try:
            r = main.extract_endpoint(
                {
                    "label": ver,
                    "fileName": "aaa.pdf",
                    "filePath": str(path),
                    "labelSource": "content",
                }
            )
            ok(r.label == ver, "content label %s survives a meaningless file name" % ver)
        except Exception as e:  # noqa: BLE001
            ok(False, "content label %s rejected: %r" % (ver, e))

        # ② 同样载荷但按上传顺序 → 旧行为就该 400（对照）
        try:
            main.extract_endpoint(
                {
                    "label": ver,
                    "fileName": "aaa.pdf",
                    "filePath": str(path),
                    "labelSource": "positional",
                }
            )
            ok(False, "positional label %s should have been rejected (old behaviour)" % ver)
        except main.HTTPException as e:
            ok(getattr(e, "status_code", 0) == 400, "positional label %s rejected with 400" % ver)
        except Exception as e:  # noqa: BLE001
            ok(False, "positional label %s raised %r, expected HTTPException 400" % (ver, e))

    # ③ 内容与文件名矛盾 → 以内容为准，且说出来
    ver_a, ver_b = sorted(sources)[:2]
    disagree_name = {
        "A": "GB4785_V4.3.5_draft.pdf",
        "B": "GB4785-2019.pdf",
        "C": "UN-R48-09.pdf",
    }.get(ver_b, "something-else.pdf")
    try:
        r = main.extract_endpoint(
            {
                "label": ver_a,
                "fileName": disagree_name,
                "filePath": str(sources[ver_a]),
                "labelSource": "content",
            }
        )
        ok(r.label == ver_a, "content wins over a disagreeing file name")
        ok(bool(r.label_inferred), "the disagreement is reported (label_inferred=True), not swallowed")
    except Exception as e:  # noqa: BLE001
        ok(False, "disagreeing file name rejected: %r" % (e,))

    print("  %d case(s) failed" % FAILURES)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main_run())
