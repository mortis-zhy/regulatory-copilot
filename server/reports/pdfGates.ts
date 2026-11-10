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
 * **不拦** —— 那是**环境**缺工具，不是这份 PDF 有问题。
 * 但要在日志里说清楚（否则「没跑」和「跑过且干净」长得一样）。
 * 仓库里的 `npm run verify` 仍然会跑同一个检查（那里一定有 Python）。
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
 */
export class PdfGateError extends Error {
  readonly code = "pdf_gate_failed";
  constructor(readonly outcomes: PdfGateOutcome[]) {
    const bad = outcomes.filter((o) => o.status === "violations");
    super(
      `渲染后的 PDF 自检未通过（${bad.length} 项）：` +
        bad.map((o) => `${o.script} —— ${o.output.split("\n").slice(0, 4).join(" ")}`).join("；"),
    );
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
 * 返回 `skipped` 时**不算失败** —— 那是环境缺 Python。
 */
export function runRenderGate(pdf: Buffer): PdfGateOutcome {
  const script = findScript("render_gate.py");
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
 * 跑完所有 PDF 自检 —— **有违规就抛**。
 *
 * 「没跑成」不抛（环境缺工具），但会打日志 ——
 * 否则「没跑」和「跑过且干净」在日志里长得一样。
 */
export function assertPdfGates(pdf: Buffer): PdfGateOutcome[] {
  const outcomes = [runRenderGate(pdf)];
  for (const o of outcomes) {
    if (o.status === "skipped") {
      console.warn(`[pdf-gate] ${o.script} 没跑成：${o.output}`);
    } else if (o.status === "ok") {
      console.log(`[pdf-gate] ${o.script} 通过：${o.output}`);
    }
  }
  if (outcomes.some((o) => o.status === "violations")) {
    throw new PdfGateError(outcomes);
  }
  return outcomes;
}
