/**
 * Normative-references diff — extracts GB / UN / ECE / R.E. standard references
 * from A and B full texts and computes added/removed/kept sets.
 *
 * This fills a real omission: the previous reports never compared 规范性引用
 * 文件, yet the reference report 11.6 explicitly flags "第2章 规范性引用 修改".
 */
import PACK_JSON from "../../data/standard-pack.json";
import { fill } from "./reportMeta";

export type RefDiff = {
  added: string[];    // regulations A cites but B doesn't (new references)
  removed: string[];  // B cites but A dropped
  kept: string[];     // cited by both
};

/** Normalise a reference token: strip spaces/slashes, canonical GB/T form. */
function norm(s: string): string {
  return s.replace(/[\s/]/g, "").toUpperCase();
}

export function extractRefs(text: string): Set<string> {
  const out = new Set<string>();
  // GB standards (GB, GB/T, GB 1234.5)
  const reGb = /GB\s*T?\s*\d{4,5}(?:\.\d+)?/g;
  for (const m of text.matchAll(reGb)) out.add(norm(m[0]));
  // UN regulations
  const reUn = /UN\s*R(?:egulation)?\.?\s*(\d+)/gi;
  for (const m of text.matchAll(reUn)) out.add("UNR" + m[1]);
  // ECE regulations
  const reEce = /ECE\s*R\.?\s*(\d+)/gi;
  for (const m of text.matchAll(reEce)) out.add("ECER" + m[1]);
  // R.E. resolutions
  const reRes = /R\.\s*E\.\s*(\d+)/gi;
  for (const m of text.matchAll(reRes)) out.add("RE" + m[1]);
  return out;
}

export function diffRefs(aText: string, bText: string): RefDiff {
  const a = extractRefs(aText);
  const b = extractRefs(bText);
  const added = [...a].filter((r) => !b.has(r)).sort();
  const removed = [...b].filter((r) => !a.has(r)).sort();
  const kept = [...a].filter((r) => b.has(r)).sort();
  return { added, removed, kept };
}

function fmt(r: string): string {
  // prettify: GBT45603 → GB/T 45603 ; UNR10 → UN R10 ; ECER48 → ECE R48 ; RE5 → R.E.5
  if (r.startsWith("GB") && /^GBT?\d/.test(r)) {
    const mm = r.match(/^GB(T?)(\d+(?:\.\d+)?)$/);
    if (mm) return mm[1] ? `GB/T ${mm[2]}` : `GB ${mm[2]}`;
  }
  if (r.startsWith("UNR")) return "UN R" + r.slice(3);
  if (r.startsWith("ECER")) return "ECE R" + r.slice(4);
  if (r.startsWith("RE")) return "R.E." + r.slice(2);
  return r;
}

/**
 * §2.3 那段叙述 —— **从声明取**（`data/standard-pack.json` 的 `refDiffNarrative`）。
 *
 * 里面的**举例**是这套标准特有的（哪些引用被新增/删除、叫什么），
 * 写死在这里，换标准后它会照旧讲旧标准。
 *
 * 缺了就**抛错**：静默少掉一句「新增 N 项…」，读者看不出来 ——
 * 那比留着一个明显的错误更糟。
 */
function narrative(addedCount: number, removedCount: number): string {
  const tpl = String((PACK_JSON as any).refDiffNarrative ?? "").trim();
  if (!tpl) {
    throw new Error(
      "标准声明里没有 `refDiffNarrative` —— §2.3「规范性引用文件对比」那段叙述" +
        "的举例是这套标准特有的，不能靠推导；缺了它，报告会**少一句话**而读者看不出来。",
    );
  }
  const out = fill(tpl, { added: String(addedCount), removed: String(removedCount) });
  if (/\{/.test(out)) {
    throw new Error(`refDiffNarrative 里有没填上的槽位：${out}`);
  }
  return out;
}

export function buildRefSection(refDiff: RefDiff): string {
  const { added, removed, kept } = refDiff;
  const rowsAdd = added.length ? added.map((r) => `| [新增] | ${cell(fmt(r))} |`).join("\n") : "| — | 无 |";
  const rowsRem = removed.length ? removed.map((r) => `| [删除] | ${cell(fmt(r))} |`).join("\n") : "| — | 无 |";
  const keptList = kept.map(fmt).join("、") || "无";
  return [
    "## 2.3 规范性引用文件对比",
    "",
    narrative(added.length, removed.length),
    "",
    `**详情**：新增 ${added.length} 项 · 删除 ${removed.length} 项 · 两者共有 ${kept.length} 项（${keptList}）`,
    "",
    "### 2.N.1 新增引用",
    "",
    "| 状态 | 引用标准 |",
    "|---|---|",
    rowsAdd,
    "",
    "### 2.N.2 删除引用",
    "",
    "| 状态 | 引用标准 |",
    "|---|---|",
    rowsRem,
    "",
    "> 数据源：A/B 原文全文逐条对照核验；完整引用清单见附录 A 的表格。",
  ].join("\n");
}

function cell(s: string): string {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}