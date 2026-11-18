/**
 * 公式**符号表**的已知答案用例 —— **不调模型** ✓、不读真语料 ✓。
 *
 * 钉住三条：
 * 1. 只判「有没有定义 / 单位 / 页码」✓，**不判语义** ✗；
 * 2. 「某版未找到定义」**不是**「那一版没这个符号」✗（措辞必须留余地）；
 * 3. 单位只比**两边都读出来**的那几版 ✓（没读出不等于不同 ✗）。
 */
import assert from "node:assert/strict";
import { compareSymbols, renderSymbolTable } from "./dist/formulaSymbols.js";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

console.log("\n[test-formula-symbols] 公式符号表的跨版对照");

const ledger = {
  blocks: [
    {
      version: "A",
      page: 85,
      symbols: [
        { symbol: "h1", definition: "是在垂直屏幕上测量的离地高度（单位：mm）", unit: "mm" },
        { symbol: "h2", definition: "是基准中心的离地高度（单位：mm）", unit: "mm" },
        { symbol: "L", definition: "是屏幕到基准中心间的距离（单位：mm）", unit: "mm" },
      ],
    },
    {
      version: "B",
      page: 72,
      symbols: [
        { symbol: "h1", definition: "是在垂直屏幕上测量的离地高度,单位为毫米(mm)", unit: "mm" },
        { symbol: "h2", definition: "是基准中心的离地高度,单位为毫米(mm)", unit: "mm" },
        { symbol: "L", definition: "是屏幕到基准中心间的距离,单位为毫米(mm)", unit: "mm" },
      ],
    },
    {
      version: "C",
      page: 127,
      symbols: [
        { symbol: "h1", definition: "the height above the ground, in millimetres", unit: "mm" },
        { symbol: "h2", definition: "the height above the ground, in millimetres", unit: "mm" },
        { symbol: "L", definition: "the distance, in millimetres, from the screen", unit: "mm" },
      ],
    },
  ],
};

const c = compareSymbols(ledger);
ok(c.versions.join(",") === "A,B,C", "版本应排成 A,B,C");
ok(c.rows.map((r) => r.symbol).join(",") === "h1,h2,L", "符号顺序应按首次出现");
ok(c.missing.length === 0, "三版都有定义时不应报缺失");
ok(c.unitMismatch.length === 0, "三版单位都是 mm 时不应报不同");
ok(c.rows[0].byVersion.C.page === 127 && c.rows[0].byVersion.C.unit === "mm", "C 的页码/单位取错了");

const md = renderSymbolTable(ledger);
ok(md.includes("单位均为 **mm**"), "三版同单位应写「单位均为 mm」");
ok(md.includes("p85") && md.includes("p72") && md.includes("p127"), "页码应出现在表里");
ok(md.includes("须人判"), "没写「语义须人判」这条界线");
ok(!md.includes("两版一致") || !md.includes("定义一致"), "不许把「文字不同」写成「定义一致」");

// 某版缺定义 ⇒ **未找到定义**，不是「没有这个符号」
const miss = compareSymbols({
  blocks: [
    { version: "A", page: 1, symbols: [{ symbol: "h1", definition: "定义甲", unit: "mm" }] },
    { version: "B", page: 2, symbols: [] },
  ],
});
ok(miss.missing.length === 1 && miss.missing[0].versions[0] === "B", "未定义应记在 missing，并指名 B");
ok(miss.rows[0].byVersion.B === null, "未定义的版本应为 null");
const mdMiss = renderSymbolTable({
  blocks: [
    { version: "A", page: 1, symbols: [{ symbol: "h1", definition: "定义甲", unit: "mm" }] },
    { version: "B", page: 2, symbols: [] },
  ],
});
ok(mdMiss.includes("未找到定义"), "缺定义时应写「未找到定义」");
ok(!mdMiss.includes("不存在"), "不许写「不存在」—— 可能只是写法不同");

// 单位不同 ⇒ 报「单位不同」；**一边没读出** ⇒ 不算不同 ✓
const unitDiff = compareSymbols({
  blocks: [
    { version: "A", page: 1, symbols: [{ symbol: "x", definition: "定义甲", unit: "mm" }] },
    { version: "B", page: 2, symbols: [{ symbol: "x", definition: "定义乙", unit: "%" }] },
  ],
});
ok(unitDiff.unitMismatch.length === 1, "mm vs % 应报单位不同");
const unitUnknown = compareSymbols({
  blocks: [
    { version: "A", page: 1, symbols: [{ symbol: "x", definition: "定义甲", unit: "mm" }] },
    { version: "B", page: 2, symbols: [{ symbol: "x", definition: "定义乙", unit: "" }] },
  ],
});
ok(unitUnknown.unitMismatch.length === 0, "一边没读出单位时不应报「不同」");

// 空台账 ⇒ 明说「未找到定义块」，不许写成一致
const empty = renderSymbolTable({ blocks: [] });
ok(empty.includes("没有**找到") && empty.includes("不判定"), "空台账应说明「不判定」");
ok(!empty.includes("一致 ✓"), "空台账不许写成一致");

console.log(`\n✓ 公式符号表用例全过（${n} 条断言）`);
