#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""条款切分的**已知答案**用例 ✓（不调模型 ✓、不联网 ✓）。

钉住三件事：
1. **英文本的章标题会把链条重开** ✓ —— 否则封面里的一个数字就把整本书带偏 ✗
   （实测 R148 全本只切出 **2** 条垃圾条款号 ✗ ⇒ 修好后 **150** 条 ✓）；
2. **中文本的切分一个字都不变** ✓（GB 三版 609/501/951 ✓）——
   全大写判据对中文标题**不成立** ✓，所以中文本零影响 ✓；
3. **章号 > 20 的不是条款** ✓（封面上的 `30.9.2021` 是日期 ✗；附录 400/500 也不是 ✓）
   ⇒ 丢掉它们 ✓，但**章号合理的必须留着** ✓（`3.9` 是第 3 章的真条款 ✓）。

跑法：python scripts/test_clause_split.py
"""
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import clause_split  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_pdf(lines, path):
    import fitz

    d = fitz.open()
    page = d.new_page()
    for ln in lines:
        page.insert_text((60, 40 + 14 * lines.index(ln)), ln, fontsize=10)
    d.save(path)
    d.close()


class ClauseSplitTests(unittest.TestCase):
    def test_english_chapter_heading_resets_the_chain(self):
        """英文本：封面上的数字**不能**把后面的章节带偏 ✓。"""
        import fitz

        tmp = os.path.join(tempfile.gettempdir(), "cs-en.pdf")
        d = fitz.open()
        p = d.new_page()
        # 封面：一堆像条款号的数字 + 目录
        for i, ln in enumerate(["30.9.2021", "400.1", "1.1", "1.2"]):
            p.insert_text((60, 60 + 14 * i), ln, fontsize=10)
        # 第 2 页：章标题（号与标题**分成两行** ✓）+ 两条条款
        p2 = d.new_page()
        for i, ln in enumerate(["4.", "GENERAL TECHNICAL REQUIREMENTS", "4.1.", "The lamps shall conform.",
                                "4.2.", "The lamps must be so designed."]):
            p2.insert_text((60, 60 + 14 * i), ln, fontsize=10)
        d.save(tmp)
        d.close()

        idx = clause_split.split_clauses(tmp)
        keys = list(idx)
        self.assertIn("4.1", keys, "英文本的章标题没有把链条重开 ⇒ 4.1 认不出")
        self.assertIn("4.2", keys, "章之后的条款没认出来")
        self.assertNotIn("30.9.2021", keys, "封面上那个日期被当成条款了")
        os.unlink(tmp)

    def test_chinese_corpus_is_untouched(self):
        """中文本（GB 三版）：条款数**一个都不能变** ✓。"""
        docs = clause_split.pick_docs()
        expected = {"A": 609, "B": 501, "C": 951}
        for v, want in expected.items():
            p = docs.get(v)
            if not p:
                continue
            got = len(clause_split.split_clauses(p))
            self.assertEqual(got, want, "%s 版条款数变了（%s ≠ %s）" % (v, got, want))

    def test_top_number_above_20_is_not_a_clause(self):
        """章号 > 20 的不是条款 ✓（封面日期 / 附录编号 ✓）。"""
        self.assertEqual(clause_split._top("30.9.2021"), 30)
        self.assertEqual(clause_split._top("400.1"), 400)
        self.assertEqual(clause_split._top("3.9"), 3)
        self.assertEqual(clause_split._top(""), 999)

    def test_chinese_headings_are_not_mistaken_for_english_chapters(self):
        """中文章标题（「4 一般要求」）**不是**全大写 ⇒ 不触发重开 ✓。"""
        lines = ["4.", "一般要求", "4.1.", "某些要求。"]
        self.assertFalse(clause_split.chapter_title_after(lines, 0))
        lines_en = ["4.", "GENERAL TECHNICAL REQUIREMENTS"]
        self.assertTrue(clause_split.chapter_title_after(lines_en, 0))
        # 表格里的碎片（「20」+「T38」）也不能被当成章号 ✓
        lines_tbl = ["20", "T38", "SY2"]
        self.assertFalse(clause_split.chapter_title_after(lines_tbl, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
