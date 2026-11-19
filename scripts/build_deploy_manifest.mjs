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
const WANT_DIRS = [
  "server/",
  "shared/",
  "client/",
  "scripts/",
  "data/",
  "web/",
  "drizzle/",
  "uploaded-docs/",
  // **pnpm 的补丁目录** ✓ —— package.json 里有 `patchedDependencies` ✓
  // （`wouter@3.7.1` ✓），少了它 ⇒ `pnpm install` 直接 **ENOENT** ✗（实测踩过 ✓）。
  "patches/",
];
const WANT_ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  ".env.example",
  ".gitignore",
  // **Python 依赖清单** ✓ —— 服务器要装它们 ✓（抽图/裁字/自检都靠它们 ✗ 少了就装不上 ✓）。
  // 少了它 ⇒ `pip install -r requirements.txt` 直接 **no such file** ✗（实测踩过 ✓）。
  "requirements.txt",
  "requirements-ocr.txt",
];
/** `reports/` 里只要**产物数据** ✓（不要 PDF ✗ —— 交付件在服务器上用不到 ✓）。 */
const WANT_REPORTS = ["figure-hashes.json", "figure-ocr.json", "multimodal.json", "last-report.json", "page-count.json"];

function tracked() {
  // **已提交**的文件 ✓ —— 服务器从 GitHub 拉的是 **HEAD 里的 blob** ✓，
  // 工作区里还没提交的新文件在 GitHub 上**不存在** ✗（会 404 ✗）。
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/** 某个文件在 **HEAD 里**的**字节** ✓ —— 服务器上的就是它 ✓。 */
function blobOf(rel) {
  return execFileSync("git", ["cat-file", "blob", `HEAD:${rel}`], {
    cwd: ROOT,
    encoding: "buffer",
    // **默认 1 MB 上限不够** ✗ —— `reports/last-report.json` 有 1.9 MB ✓、
    // 源 PDF 有 5 MB ✓ ⇒ 不给上限直接 ENOBUFS ✗（实测踩过 ✓）。
    maxBuffer: 64 * 1024 * 1024,
  });
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
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const lines = [
  "# 部署清单 —— 服务器按它逐个文件从 CDN 拉 ✓",
  "# 格式：<sha256>  <相对路径>   —— 拉完逐个核对 sha256 ✓",
  "# sha256 取的是 **HEAD 里的 blob** ✓ —— 服务器上的就是它 ✓（工作区可能是 CRLF ✗，与 blob 不一致 ✗）",
  `# commit ${commit}   —— 服务器按这个 commit 取文件 ✓（钉住版本 ⇒ 不会拿到缓存里的旧版 ✗）`,
  `# 生成器：scripts/build_deploy_manifest.mjs · 文件数 ${files.length}`,
];
let bytes = 0;
for (const rel of files) {
  const buf = blobOf(rel);
  bytes += buf.length;
  lines.push(`${createHash("sha256").update(buf).digest("hex")}  ${rel}`);
}
const outDir = path.join(ROOT, "deploy");
fs.mkdirSync(outDir, { recursive: true });
const outArg = process.argv.find((a) => a.startsWith("--out="));
const outFile = outArg ? outArg.slice("--out=".length) : path.join(outDir, "manifest.txt");
fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
console.log(
  `部署清单：${files.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(1)} MB → ${path.relative(ROOT, outFile)}`,
);
