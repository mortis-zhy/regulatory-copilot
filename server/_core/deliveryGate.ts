/**
 * Delivery gate — the last thing that runs before a PDF reaches a client.
 *
 * Why this exists: `npm run verify` is a command a human has to remember. Two
 * consecutive deliveries shipped broken reports while that command was green,
 * because it asserted internal consistency (sections present, 45 == 45, no
 * orphan "#") but nothing asserted that the source data actually REACHES the
 * reader. Deleting the entire parameter matrix, or renaming the appendix-C
 * version column so the triptych renderer stopped recognising it, both passed
 * every check and produced a report the client could not use.
 *
 * These checks are deliberately about *reach*, not correctness of derivation —
 * verify_claims.py and audit_pages.py own that. Each failure below corresponds
 * to a defect that actually shipped.
 *
 * Kept in sync with scripts/verify.mjs by asserting the same predicates; if one
 * of them changes, change it in both places.
 */
import fs from "node:fs";
import path from "node:path";

/** Header names the triptych renderer in htmlRenderV8.ts recognises as a version column. */
const RENDERER_VERSION_HEADER = /^(版本|来源|文档|文件|标准|version|document|file)$/i;

function innerRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "verify_claims.py"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(import.meta.dirname, "../..");
}

export type GateResult = { ok: boolean; checks: number; failures: string[] };

/**
 * @param report  the RenderableReport about to be delivered
 * @param rootOverride  repo root; defaults to the located inner root
 */
export function checkDelivery(report: any, rootOverride?: string): GateResult {
  const ROOT = rootOverride ?? innerRoot();
  const failures: string[] = [];
  let checks = 0;

  const md = [
    ...(report.chapters ?? []),
    ...(report.appendices ?? []),
  ]
    .map((c: any) => c?.markdown ?? "")
    .join("\n");

  const diffPath = path.join(ROOT, "diff-result.json");
  const hasDiff = fs.existsSync(diffPath);
  const valueDiffs: any[] = hasDiff
    ? (JSON.parse(fs.readFileSync(diffPath, "utf-8")).valueDiffs ?? [])
    : [];

  const check = (name: string, fn: () => string | null) => {
    checks++;
    try {
      fn();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 1. The parameter matrix is the deliverable's centrepiece. It was silently
  //    absent for two delivery rounds.
  check("§11.3.3 参数对照矩阵", () => {
    const i = md.indexOf("### 11.3.3");
    if (i < 0) throw new Error("章节缺失 — 安装高度/角度/频率/车速 对照表不在报告里");
    const next = md.indexOf("\n### ", i + 5);
    const section = md.slice(i, next < 0 ? undefined : next);
    const rows = (section.match(/^\| \d\d \| /gm) ?? []).length;
    if (valueDiffs.length && rows < valueDiffs.length) {
      throw new Error(`只列出 ${rows}/${valueDiffs.length} 行参数 — 有参数维度缺失`);
    }
    return `${rows} 行`;
  });

  // 2. C (UN R48) must be a real column, not an empty one. The keyword filter
  //    used to be Chinese-only while R48 headings are English, so chapters 4–9
  //    rendered "源数据未提供" for C.
  check("C UN R48 列", () => {
    const cRef = (source: string) => {
      const m = String(source ?? "").match(/C=((?:\d+(?:\.\d+)+)|Annex\s*\d+[A-Za-z]?)/i);
      return m ? m[1].replace(/\s+/g, " ") : null;
    };
    const expected = valueDiffs.filter((v) => cRef(v.source));
    if (!expected.length) return "no C data in diff-result";
    const cited = expected.filter((v) => {
      const ref = cRef(v.source)!;
      return md.includes(`R48 ${ref}`);
    }).length;
    if (cited < expected.length) {
      throw new Error(`${cited}/${expected.length} 行引用了自己的 R48 条款 — C 列可能为空或条款号被截断`);
    }
    return `${cited}/${expected.length}`;
  });

  // 3. The executive summary must state conclusions. It previously listed
  //    counts ("新增 9 项") and left the judgement to the reader.
  check("执行摘要决策结论", () => {
    const i = md.indexOf("本报告的结论");
    if (i < 0) throw new Error("执行摘要只有逐条统计，没有「本报告的结论（按决策口径）」段");
    const block = md.slice(i, i + 1600);
    const numbered = (block.match(/^\d\. \*\*/gm) ?? []).length;
    if (numbered < 3) throw new Error(`决策口径只有 ${numbered} 条，应至少 3 条（设计/编号/出口/不可用）`);
    return `${numbered} 条`;
  });

  // 4. Appendix C must still be shaped like a version table. A renamed header
  //    is invisible in the markdown but turns every topic into three
  //    "源数据未提供" cards in the PDF.
  check("附录C 三版本表", () => {
    const start = md.search(/# 附录 C/);
    if (start < 0) throw new Error("附录 C 缺失");
    // Array.from rather than spread: this project's tsconfig targets ES5, so
    // spreading a RegExpStringIterator is a compile error even though esbuild
    // handles it fine at runtime.
    const cells = Array.from(md.slice(start).matchAll(/^\| *([^|]+?) *\|/gm)).map((m) =>
      m[1].replace(/\*/g, "").trim(),
    );
    if (!cells.some((c) => RENDERER_VERSION_HEADER.test(c))) {
      throw new Error(
        `表头 [${cells.slice(0, 3).join(" / ")}] 不在渲染器版本列白名单内 — 三栏卡片会全部退回占位符`,
      );
    }
    const a = (md.match(/^\| A \| \d/gm) ?? []).length;
    const c = (md.match(/^\| C \| \d/gm) ?? []).length;
    if (!a || !c) throw new Error(`三版本行缺失 (A=${a}, C=${c})`);
    return `A ${a} / C ${c}`;
  });

  // 5. Chapters that promise a three-column topic comparison must actually
  //    carry C rows — this is the exact shape of the "R48 内容为空" defect.
  //    Look for C's own table rows, not the string "R48": the rows are labelled
  //    `| **C** | 6.1 | … |` and the excerpt is R48 prose.
  //    Only narrative chapters are checked. The executive summary *describes*
  //    that other chapters carry A|B|C ("24 个核心主题做了 A|B|C 三列原文摘录
  //    对照") without carrying such a table itself, so testing it would always
  //    report a false regression.
  check("章节内 C 版原文", () => {
    const claimed = (report.chapters ?? []).filter(
      (c: any) => /三列原文对照/.test(c.markdown ?? ""),
    );
    if (!claimed.length) return "no chapter claims a three-column table";
    const empty = claimed.filter((c: any) => !(c.markdown ?? "").match(/^\|\s*\*{0,2}C\*{0,2}\s*\|/m));
    if (empty.length) {
      throw new Error(
        `${empty.length} 章声称三列对照却没有 C 行: ${empty.map((c: any) => c.title).join(", ")}`,
      );
    }
    return `${claimed.length} 章均有 C 行`;
  });

  // 6. Structural sections that were dropped wholesale by a placeholder-regex
  //    mismatch (the four sections that vanished from a shipped report).
  check("第 11 章结构完整性", () => {
    const missing = ["11.2 删除条款汇总", "11.3 重大修订条款", "11.3.0 同文勘误", "11.4 数据指标变化"].filter(
      (h) => !md.includes(h),
    );
    if (missing.length) throw new Error(`缺失章节: ${missing.join(", ")}`);
    return "11.2 / 11.3 / 11.3.0 / 11.4";
  });

  // The parameter matrix is what the customer actually buys, and it is the one
  // artefact that can silently collapse: a regex that stops matching after a
  // wording tweak leaves an empty column that still looks like a rendered
  // table. Refuse the PDF rather than ship it.
  //
  // The thresholds are per-role, not per-letter: the national pair must be
  // mostly extracted, and every remaining version (the international reference)
  // must be non-empty. Naming "C" here is what made this check mean "GB 4785
  // plus R48" and nothing else.
  check("参数矩阵多版覆盖", () => {
    const rows = report?.parameterMatrix;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("报告未携带 parameterMatrix —— 第 12 章矩阵缺失，无法做多版对照");
    }
    const keys = [...new Set(rows.flatMap((r: any) => Object.keys(r?.cells ?? {})))].sort();
    if (keys.length < 3) {
      throw new Error(`矩阵只有 ${keys.length} 版（${keys.join("/")}）—— 多版对照至少需要 3 版`);
    }
    const hit = (k: string) => rows.filter((r: any) => r?.cells?.[k]?.status === "verified").length;
    // The two national versions are the ones the customer compares against each
    // other, so they get the strict floors (the newest draft is the one being
    // calibrated, and it degrades first); every reference version must at least
    // exist. Legacy flat rows (pre-`cells` reports) are read via A/B/C.
    const at = (r: any, k: string) => r?.cells?.[k] ?? r?.[k];
    const FLOORS = [0.8, 0.6];
    keys.slice(0, 2).forEach((k, i) => {
      const n = rows.filter((r: any) => at(r, k)?.status === "verified").length;
      if (n < rows.length * FLOORS[i]) {
        throw new Error(`${k} 列仅 ${n}/${rows.length} 有取值，抽取已退化`);
      }
    });
    const reference = keys.slice(2);
    const emptyRef = reference.filter((k) => hit(k) === 0);
    if (emptyRef.length) {
      throw new Error(`${emptyRef.join("/")} 列全空 —— 出口对照无从谈起`);
    }
    const full = rows.filter((r: any) => keys.every((k) => at(r, k)?.status === "verified")).length;
    return `${rows.length} 参数 · ${keys.map((k) => `${k} ${hit(k)}`).join(" / ")} · 三版齐全 ${full}`;
  });

  return { ok: failures.length === 0, checks, failures };
}

/** Promise wrapper so route handlers can `await` it alongside other work. */
export async function runDeliveryGate(report: any, rootOverride?: string): Promise<GateResult> {
  return checkDelivery(report, rootOverride);
}
