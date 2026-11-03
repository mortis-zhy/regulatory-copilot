/**
 * 项目根 —— 从本文件向上找，认 `data/parameter-specs.json` 为准。
 *
 * ## 为什么不能写死相对路径
 *
 * 原来各处写的是 `path.resolve(import.meta.dirname, "../reports")` ——
 * 那**只对打包后的布局成立**（`dist/index.mjs` → `dist/../reports` = 仓库的 `reports/`）。
 * 开发模式跑的是**源码**（`server/_core/index.ts`），`import.meta.dirname` 是 `server/_core/`，
 * 于是 `../reports` 落到 **`server/reports/`** —— 一个**没人读、没人看**的目录。
 *
 * 症状（2026-11-03 用浏览器 MCP 跑全流程时撞上）：
 *   - 网站把上传的文件写进 `server/uploaded-docs/`，
 *     而**回源复核层读的是仓库根的 `uploaded-docs/`** ——
 *     于是**网站上传的新标准，管线根本看不见**：
 *     认不出它是哪一版、复核不了它的取值。**泛化断在第一步。**
 *   - 网站把生成的报告写进 `server/reports/last-report.json`，
 *     而 CLI 的 `rebuild_report.mjs` 与全部闸门读的是**仓库根的 `reports/last-report.json`** ——
 *     **两份真相来源**，正是这个项目治过好几次的病。
 *
 * ## 认据
 *
 * `data/parameter-specs.json` —— 数据源层的锚点。
 * 源码里本文件在 `server/_core/`，打包后在 `dist/`；两种布局向上都能找到它。
 * 找不到就**抛错**：宁可起不来，也不要静默读到别人的目录
 * （另一个仓库的同名目录读起来是「成功」的，只是内容不对 —— 那种错最难发现）。
 */
import fs from "node:fs";
import path from "node:path";

export function findProjectRoot(): string {
  if (process.env.COMPARE_AGENT_ROOT) return process.env.COMPARE_AGENT_ROOT;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "data", "parameter-specs.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    "找不到项目根（向上 8 层内没有 data/parameter-specs.json）—— 设 COMPARE_AGENT_ROOT",
  );
}

export const PROJECT_ROOT = findProjectRoot();

/** 报告 JSON 的落点（CLI 与网站必须是同一个文件）。 */
export const REPORT_FILE = path.join(PROJECT_ROOT, "reports", "last-report.json");

/** 上传文档的落点（回源复核层读的就是这里）。 */
export const UPLOADED_DOCS_DIR = path.join(PROJECT_ROOT, "uploaded-docs");
