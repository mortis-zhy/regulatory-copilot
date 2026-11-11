/**
 * 渲染后的 PDF **自检** —— 必要检查失败时**拦住交付**（同事 issue #4 完成标准 1）。
 *
 * ## 为什么要单独一个模块
 *
 * `render_gate.py` 这个检查**一直都在**，但它跑在 `finalizePdf()` 里，
 * 而那里的写法是：
 *
 * ```py
 * catch (e) { console.warn("gate render FAILED: …") }   // 只记日志
 * ```
 *
 * 也就是说：**检查失败了，PDF 还是照发**。
 * 交付件第 234 页上印着 `<table><tr><td> vr </td>` —— 客户看得见，
 * 而闸门**一声没吭**。
 *
 * 检查放在渲染路径里（而不是「渲染完之后另跑一步」），
 * 是因为**三个下载入口**都走 `renderPdfFromReportV8()` ——
 * 放在那里，**每个入口**都自动被管住；
 * 放在别的地方，就得记得在三处都补一遍（漏一处就白做）。
 *
 * ## 环境缺 Python / PyMuPDF 怎么办
 *
 * **拦** ✓ —— 「没跑成」**不等于**「通过」✓。
 * 同事 2026-11-10 复核发现 ✗：原来这里不拦，于是 Python 不可用时
 * 检查返回 `skipped`，闸门上是**绿的** ✗ —— 而它**什么都没查** ✗。
 *
 * 「安静的绿色」比「响亮的红色」更危险 ✓：
 * 它让人以为「有闸门就说明没问题」✗。
 * 报错里会说清**缺什么** ✓（运维照着就能修 ✓）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type PdfGateOutcome = {
  /** 脚本名 */
  script: string;
  /** 通过 / 有违规 / 没跑成 */
  status: "ok" | "violations" | "skipped";
  /** 脚本输出（给人看的） */
  output: string;
};

/**
 * 自检没过 —— **拦住交付**。
 *
 * 名字与 `RenderLayoutError` 分开：版面自检是**排版**问题，
 * 这个是**内容泄漏**问题；报错时要说清是哪一类。
 *
 * ## ⚠ 「**没跑成**」也算失败（同事 2026-11-10 复核发现 ✗）
 *
 * 原来只有「查出违规」才抛 ✗ —— 于是 Python 不可用时，
 * 检查返回 `skipped`，闸门上是**绿的** ✗。
 *
 * **没跑成 ≠ 通过** ✓ —— 一个没跑过的检查**什么都没查** ✗，
 * 而「安静的绿色」比「响亮的红色」更危险 ✓：
 * 它让人以为「有闸门就说明没问题」✗。
 *
 * （这跟上一轮修的「渲染失败不许降级成 skipped」是**同一个毛病** ✗ ——
 * 我自己在另一个地方又犯了一次 ✗。）
 */
export class PdfGateError extends Error {
  readonly code = "pdf_gate_failed";
  constructor(readonly outcomes: PdfGateOutcome[]) {
    const bad = outcomes.filter((o) => o.status === "violations");
    const skipped = outcomes.filter((o) => o.status === "skipped");
    const parts: string[] = [];
    if (bad.length) {
      parts.push(
        `查出 ${bad.length} 项违规：` +
          bad.map((o) => `${o.script} —— ${o.output.split("\n").slice(0, 4).join(" ")}`).join("；"),
      );
    }
    if (skipped.length) {
      parts.push(
        `${skipped.length} 项**没跑成**（不是「通过」）：` +
          skipped.map((o) => `${o.script} —— ${o.output}`).join("；"),
      );
    }
    super("渲染后的 PDF 自检未通过 —— " + parts.join(" ｜ "));
    this.name = "PdfGateError";
  }
}

/** 脚本在仓库根目录。 */
function findScript(name: string): string | null {
  const roots = [process.cwd(), path.resolve(process.cwd(), "..")];
  for (const r of roots) {
    const p = path.join(r, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 跑 `render_gate.py`（PDF 泄漏 / 工具黑话检查）。
 *
 * 返回 `skipped` = **没跑成** ✓（脚本不在 / Python 不可用 ✓）——
 * 调用方（`assertPdfGates`）会**因此拦住交付** ✓。
 */
export function runRenderGate(
  pdf: Buffer,
  opts: { scriptPath?: string } = {},
): PdfGateOutcome {
  // **脚本路径可覆盖** ✓ —— 让「没跑成」这条路径**可测** ✓
  // （否则闸门只能测「跑成了」✓，而同事 2026-11-10 指出的正是
  //   「模拟 Python 不可用 → skipped 后未抛错」✗）。
  const script = opts.scriptPath ?? findScript("render_gate.py");
  if (!script) {
    return {
      script: "render_gate.py",
      status: "skipped",
      output: "仓库里找不到 render_gate.py —— 没跑成（不是「通过」）",
    };
  }
  let dir = "";
  let inPath = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfgate-"));
    inPath = path.join(dir, "out.pdf");
    fs.writeFileSync(inPath, pdf);
    const stdout = execFileSync("python", [script, inPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
      cwd: path.dirname(script),
    });
    return { script: "render_gate.py", status: "ok", output: String(stdout).trim() };
  } catch (e: any) {
    const status = e?.status === 1 ? "violations" : "skipped";
    const msg = String(e?.stdout ?? e?.message ?? "").trim();
    if (status === "skipped") {
      return {
        script: "render_gate.py",
        status: "skipped",
        output: `没跑成（不是「通过」）：${msg.split("\n").slice(0, 3).join(" ")}`,
      };
    }
    return { script: "render_gate.py", status: "violations", output: msg };
  } finally {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不该把渲染搞失败 */
    }
  }
}

/**
 * 跑完所有 PDF 自检 —— **有任何一项不是「通过」就抛** ✓。
 *
 * 「查出违规」抛 ✓；「**没跑成**」也抛 ✓（同事 2026-11-10 复核发现 ✗）——
 * 没跑过的检查**什么都没查** ✓，不能报成「通过」✗。
 */
export function assertPdfGates(
  pdf: Buffer,
  opts: { scriptPath?: string } = {},
): PdfGateOutcome[] {
  const outcomes = [runRenderGate(pdf, opts)];
  for (const o of outcomes) {
    if (o.status === "skipped") {
      console.warn(`[pdf-gate] ${o.script} 没跑成：${o.output}`);
    } else if (o.status === "ok") {
      console.log(`[pdf-gate] ${o.script} 通过：${o.output}`);
    }
  }
  // **「没跑成」也要抛** ✓（同事 2026-11-10 复核发现 ✗）——
  // 没跑过的检查**什么都没查** ✓，不能报成「通过」✗。
  if (outcomes.some((o) => o.status !== "ok")) {
    throw new PdfGateError(outcomes);
  }
  return outcomes;
}
