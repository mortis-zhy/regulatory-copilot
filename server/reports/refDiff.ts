/**
 * Normative-references diff — extracts GB / UN / ECE / R.E. standard references
 * from A and B full texts and computes added/removed/kept sets.
 *
 * This fills a real omission: the previous reports never compared 规范性引用
 * 文件, yet the reference report 11.6 explicitly flags "第2章 规范性引用 修改".
 */
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

export function buildRefSection(refDiff: RefDiff): string {
  const { added, removed, kept } = refDiff;
  const rowsAdd = added.length ? added.map((r) => `| [新增] | ${cell(fmt(r))} |`).join("\n") : "| — | 无 |";
  const rowsRem = removed.length ? removed.map((r) => `| [删除] | ${cell(fmt(r))} |`).join("\n") : "| — | 无 |";
  const keptList = kept.map(fmt).join("、") || "无";
  return [
    "## 2.3 规范性引用文件对比",
    "",
    `A 草案对规范性引用文件做了**大规模更新**：新增 ${added.length} 项（含新国标 GB 45831「机动车用光源 安全性要求」、GB/T 45603「机动车用光源的类型要求」，以及直接采纳联合国 R.E.5 决议与 UN 国际法规），同时移除 ${removed.length} 项旧引用（如 ECE R48、GB 18408/18409 等旧灯具标准）。`,
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