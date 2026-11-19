// 生成**部署清单** `deploy/manifest.txt` —— 服务器按它**逐个文件**拉源码 ✓。
//
// ## 为什么不用「整仓 zip」
//
// 实测（2026-11-19，公司那台 `asda`）：
//   · `codeload.github.com`（整仓 zip）→ **约 37 KB/s** ✗（300 MB 要几小时 ✗）；
//   · `raw.githubusercontent.com`（单个文件）→ **3.1 MB/s** ✓（13.4 MB 用 4 秒 ✓）。
// ⇒ **逐文件拉** ✓：总量只有 ~36 MB ✓ ⇒ 几分钟搞定 ✓。
//
// ## 清单里带 sha256 ⇒ 拉完能**核** ✓（下载损坏/截断会当场发现 ✗）。
//
// 用法：node scripts/build_deploy_manifest.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 服务器上**要**的文件 ✓ —— 其它一律不带 ✓（省时间 ✓）。 */
const WANT_DIRS = ["server/", "shared/", "client/", "scripts/", "data/", "web/", "drizzle/", "uploaded-docs/"];
const WANT_ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  ".env.example",
  ".gitignore",
];
/** `reports/` 里只要**产物数据** ✓（不要 PDF ✗ —— 交付件在服务器上用不到 ✓）。 */
const WANT_REPORTS = ["figure-hashes.json", "figure-ocr.json", "multimodal.json", "last-report.json", "page-count.json"];

function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function wanted(rel) {
  if (rel.startsWith("delivery/") || rel.startsWith("tmp/") || rel.startsWith("dist/")) return false;
  if (rel.startsWith("reports/")) return WANT_REPORTS.includes(rel.slice("reports/".length));
  if (rel.startsWith("docs/")) return false;
  if (rel.endsWith(".pdf") && !rel.startsWith("uploaded-docs/")) return false;
  if (WANT_ROOT_FILES.includes(rel)) return true;
  return WANT_DIRS.some((d) => rel.startsWith(d));
}

const files = tracked().filter(wanted).sort();
const lines = [
  "# 部署清单 —— 服务器按它逐个文件从 raw.githubusercontent 拉 ✓",
  "# 格式：<sha256>  <相对路径>   —— 拉完逐个核对 sha256 ✓",
  `# 生成器：scripts/build_deploy_manifest.mjs · 文件数 ${files.length}`,
];
let bytes = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  bytes += buf.length;
  lines.push(`${createHash("sha256").update(buf).digest("hex")}  ${rel}`);
}
const outDir = path.join(ROOT, "deploy");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "manifest.txt"), lines.join("\n") + "\n", "utf8");
console.log(
  `部署清单：${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(1)} MB → deploy/manifest.txt`,
);
