/**
 * 图版 —— 把源 PDF 里的**图**搬进报告。
 *
 * ## 为什么有这一层
 *
 * 实测（2026-11-12）：交付件 279 页里**图对象 0 个** —— 一张图都没有。
 * 而源 PDF 里光 B 版（GB 4785-2019）就有 39 张位图，
 * 其中 p30 那张是「1/1a/1b 类 80°/45° 可见角布局图」——
 * **图里的角度就是限值本身**，现在纸面上一个字都没有。
 *
 * MinerU 抽出来的 136 处插图**本体就在 markdown 里**
 * （`![](data:image/jpeg;base64,…)`），报告只取了 `{page, caption}` ⇒ **图本体被丢掉**。
 *
 * ## 为什么不用 MinerU 的 base64
 *
 * base64 在 markdown 里是**文档顺序**、没有页锚点；`figures[]` 只记 `page`。
 * 两边数量对不上（A 46 张 base64 vs 45 条 figure，差额正好是 chart 块），
 * 按顺序硬配就是**给错页** ⇒ 图和题注对不上 ⇒ 宁可空着，不可错着。
 *
 * 源 PDF 的图对象**自带页码与尺寸**，抽取确定、可复算 ✓。
 * 代价：矢量图（chart）抽不出 ⇒ 那几页在图版里**明确写「未抽成位图」**，不假装有图。
 *
 * ## 产物落在哪
 *
 * `dist/figures/<sha8>/`（gitignored，可由 `scripts/extract_figures.py` 重算）。
 * 源 PDF（`uploaded-docs/`）是**入库的** ⇒ 图版可复现 ✓。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInnerRoot } from "./innerRoot.js";

export type FigureFile = { file: string; w: number; h: number };

export type FigureGallery = {
  /** 仓库相对目录（`dist/figures/<sha8>`）—— 报告里的 markdown 用它拼路径 */
  dir: string;
  /** 页码 → 该页抽到的图 */
  pages: Record<string, FigureFile[]>;
  /** 图的总数 */
  total: number;
  /** 抽不出位图的页（MinerU 认出来、但源 PDF 该页没有 ≥minPx 的位图） */
  vectorPages: number[];
  /** 源 PDF 的 sha256（图版是**按内容**认的） */
  sourceSha256: string;
  /** 源 PDF 的路径（仓库相对） */
  sourcePath: string;
};

/** 小于这个边长的图不收 —— 源 PDF 里大量 40×21 的装饰/网点 */
export const FIGURE_MIN_PX = 200;

/** 抽图时的渲染 DPI（页面上那块区域按这个分辨率截出来） */
export const FIGURE_DPI = 200;

const SCRIPT = "scripts/extract_figures.py";

/** 仓库根 —— **唯一实现**在 `server/_core/projectRoot.ts`（不自己再写一份解析器） */
function projectRoot(): string {
  return resolveInnerRoot();
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** 找出**内容**匹配这份 sha 的源 PDF —— 按内容找，不按文件名 */
export function findSourcePdfBySha(sha: string): string | null {
  const root = projectRoot();
  const direct = [
    // 入库的语料：文件名就是完整 sha256 ✓
    path.join(root, "uploaded-docs", `${sha}.pdf`),
    path.join(root, "delivery", "PDF对比", `${sha}.pdf`),
    // **网页上传**：落盘名是 sha256 的**前 16 位** ✓（agentRoutes 的上传路由）
    path.join(root, "uploaded-docs", `${sha.slice(0, 16)}.pdf`),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // delivery/PDF对比/ 里的源文件按**文件名**存（`源文件_<版号>_<版名>`，带 .pdf 后缀），
  // 但报告里的版本是靠 sha 认的 —— 所以这里按内容扫一遍。
  const dirs = [
    path.join(root, "uploaded-docs"),
    path.join(root, "delivery", "PDF对比"),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.toLowerCase().endsWith(".pdf")) continue;
      const p = path.join(d, f);
      try {
        if (sha256File(p) === sha) return p;
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  return null;
}

/** 抽一页源 PDF 的实质图。已抽过就复用（manifest 对得上就不重跑） */
export function extractFiguresForPdf(
  pdfPath: string,
  outDirAbs: string,
  opts: { minPx?: number; dpi?: number; force?: boolean } = {},
): { pages: Record<string, FigureFile[]>; total: number; skipped: number } {
  const minPx = opts.minPx ?? FIGURE_MIN_PX;
  const dpi = opts.dpi ?? FIGURE_DPI;
  const manifestPath = path.join(outDirAbs, "manifest.json");
  if (!opts.force && fs.existsSync(manifestPath)) {
    try {
      const man = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (man.minPx === minPx && man.dpi === dpi && man.pdfSha256 === sha256File(pdfPath)) {
        return { pages: man.pages ?? {}, total: man.total ?? 0, skipped: man.skipped ?? 0 };
      }
    } catch {
      /* manifest 坏了 → 重抽 */
    }
  }
  fs.mkdirSync(outDirAbs, { recursive: true });
  const py = spawnSync(
    "python",
    [
      path.join(projectRoot(), SCRIPT),
      "--pdf",
      pdfPath,
      "--out",
      outDirAbs,
      "--min-px",
      String(minPx),
      "--dpi",
      String(dpi),
    ],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
  );
  if (py.status !== 0) {
    throw new Error(
      `抽图失败（${path.basename(pdfPath)}）：${(py.stderr || py.stdout || "").trim().split("\n").pop()?.slice(0, 160)}`,
    );
  }
  const res = JSON.parse(py.stdout.trim().split("\n").pop()!);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      { pdfSha256: sha256File(pdfPath), minPx, dpi, pages: res.pages, total: res.total, skipped: res.skipped },
      null,
      2,
    ),
    "utf-8",
  );
  return { pages: res.pages ?? {}, total: res.total ?? 0, skipped: res.skipped ?? 0 };
}

/**
 * 给一批版本（靠 sha 认）建图版。
 * 找不到源 PDF 的版本**不编图** —— 报告里那一版就明写「未抽成位图」。
 */
export function buildFigureGallery(
  docs: Array<{ label: string; sha256: string }>,
  opts: { minPx?: number; force?: boolean } = {},
): Record<string, FigureGallery> {
  const root = projectRoot();
  const out: Record<string, FigureGallery> = {};
  for (const d of docs) {
    const sha = (d.sha256 || "").toLowerCase();
    if (!sha) continue;
    const pdf = findSourcePdfBySha(sha);
    if (!pdf) continue;
    const dirAbs = path.join(root, "dist", "figures", sha.slice(0, 8));
    const res = extractFiguresForPdf(pdf, dirAbs, opts);
    out[d.label] = {
      dir: path.relative(root, dirAbs).replace(/\\/g, "/"),
      pages: res.pages,
      total: res.total,
      vectorPages: [],
      sourceSha256: sha,
      sourcePath: path.relative(root, pdf).replace(/\\/g, "/"),
    };
  }
  return out;
}

/** 图版里某个文件的**仓库相对**路径（markdown 里用它） */
export function figureRelPath(gallery: FigureGallery, file: string): string {
  return `${gallery.dir}/${file}`;
}

/**
 * 给语料挂上图版（**就地**改 `data[label].figureGallery`）。
 *
 * 调用点在**报告生成之前** ✓ —— `reportV6` 是纯函数，
 * 它只读 `data[label].figureGallery`，不碰文件系统 ✓。
 */
export function attachFigureGallery(
  data: Record<string, any>,
  opts: { minPx?: number; force?: boolean } = {},
): Record<string, FigureGallery> {
  const docs = Object.entries(data ?? {})
    .map(([label, v]) => ({ label, sha256: String(v?.sourceSha256 ?? "").toLowerCase() }))
    .filter((d) => d.sha256);
  const g = buildFigureGallery(docs, opts);
  for (const [label, gal] of Object.entries(g)) {
    if (data[label]) data[label].figureGallery = gal;
  }
  return g;
}
