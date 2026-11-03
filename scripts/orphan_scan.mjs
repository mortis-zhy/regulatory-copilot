/**
 * 孤儿模块扫描 —— 找出「仓库里没有任何人引用」的源文件。
 *
 * 为什么要有这个：
 *   这个项目治过好几次「两份真相来源」的病（同一个数在两处各写一遍、
 *   改了一处忘了另一处）。死代码是同一种病的另一面 —— 一份**没人读**的
 *   副本看起来像还在生效的规格。2026-11-03 盘点「换一套标准要改多少东西」
 *   时发现 server/reports 下有 4 个文件（1853 行）**零引用**：
 *   三个旧版渲染器 + 一个旧版报告入口，每一版都写死了 GB 4785 的名字、
 *   章节号、指标值。
 *
 *   它们不产出任何交付件，却让「还剩多少处标准写死」这个数**虚高**，
 *   也让下一个人以为「这个文件好像还在用，别删」。
 *
 *   死代码不会自己报错，所以要有闸门盯着。
 *
 * 判定为什么必须看 import 语句 / 路径，而不是「文件里提到过这个名字」：
 *   文档散文里出现「旧版 A、旧版 B」这样的并列名字时，朴素的
 *   「引号里出现过就算引用」会把散文当成引用，死代码就永远查不出来。
 *   这里只认三种真引用：import 语句、带扩展名的路径、以 ./ 开头的相对路径。
 *
 * 用法：
 *   node scripts/orphan_scan.mjs            # 打印 + exit 1（有孤儿时）
 *   node scripts/orphan_scan.mjs --report   # 只打印，退出码恒为 0
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描范围：这些目录下的源码会被当作「引用者」。 */
const SCAN_DIRS = ["server", "client/src", "scripts", "python_service"];
/** 顶层散落的脚本（_test_*.mjs / rebuild_report.mjs 之类）。 */
const SCAN_ROOT_FILES = true;
/** 不进入的目录名。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".vite", "coverage"]);
/** 源码后缀。 */
const SRC_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".py"]);
/** 被检查的目录（相对仓库根）。 */
const WATCH_DIRS = ["server/reports"];
/**
 * 允许存在的孤儿 —— 每个都要写清楚为什么。
 * 空的：目前 server/reports 下没有「天生就是入口」的模块，
 * 所有入口（rebuild_report.mjs / verify.mjs / 各 _test_*.mjs）都从仓库根
 * 引用它们，所以「零引用 == 死代码」在这里成立。
 */
const ORPHAN_ALLOWLIST = new Set([]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SRC_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

function collectSources() {
  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(resolve(ROOT, d)));
  if (SCAN_ROOT_FILES) {
    for (const e of readdirSync(ROOT, { withFileTypes: true })) {
      if (e.isFile() && SRC_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
        files.push(resolve(ROOT, e.name));
      }
    }
  }
  return files;
}

/** 引号里是一整条真路径时的三种形态。 */
function refPatterns(mod) {
  const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    // ① import 语句：from "…" / import("…") / require("…")
    new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'\`][^"'\`]*\\b${esc}\\b`),
    // ② 带扩展名的路径："server/reports/foo.ts" / "dist/foo.js"
    new RegExp(`["'\`][^"'\`]*\\b${esc}\\.(?:ts|tsx|js|mjs)["'\`]`),
    // ③ 相对写法："../reports/foo" / "./foo"
    new RegExp(`["'\`]\\.{1,2}\\/[^"'\`]*\\b${esc}\\b["'\`]`),
    // ④ 至少两级的路径："server/reports/foo"（一段斜杠不算，见下）
    new RegExp(`["'\`][^"'\`]*[/\\\\][^"'\`]*[/\\\\][^"'\`]*\\b${esc}\\b["'\`]`),
  ];
}

/**
 * 引用判定：只认 import 语句与真路径，不认散文里的名字。
 * 返回引用者的仓库相对路径，找不到返回 null。
 */
function isReferenced(mod, sources, selfPath) {
  const pats = refPatterns(mod);
  for (const f of sources) {
    if (f === selfPath) continue;
    let t;
    try {
      t = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const p of pats) {
      if (p.test(t)) return relative(ROOT, f).replace(/\\/g, "/");
    }
  }
  return null;
}

export function scanOrphans() {
  const sources = collectSources();
  const orphans = [];
  for (const wd of WATCH_DIRS) {
    const base = resolve(ROOT, wd);
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".ts")) continue;
      const mod = e.name.slice(0, -3);
      const selfPath = join(base, e.name);
      const by = isReferenced(mod, sources, selfPath);
      if (!by) {
        const lines = readFileSync(selfPath, "utf-8").split("\n").length;
        orphans.push({ file: `${wd}/${e.name}`, module: mod, lines });
      }
    }
  }
  orphans.sort((a, b) => b.lines - a.lines);
  return orphans;
}

// Windows 上 import.meta.url 是 file:///C:/...，直接拼字符串比不出来 ——
// 走 fileURLToPath 两边都归一成同一个绝对路径。
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const orphans = scanOrphans();
  const allowed = orphans.filter((o) => ORPHAN_ALLOWLIST.has(o.module));
  const bad = orphans.filter((o) => !ORPHAN_ALLOWLIST.has(o.module));
  if (orphans.length === 0) {
    console.log(`[orphan-scan] server/reports 下没有孤儿模块（扫了 ${WATCH_DIRS.join("、")}）`);
  } else {
    for (const o of orphans) {
      const tag = allowed.includes(o) ? "（在白名单里）" : "← 死代码";
      console.log(`[orphan-scan] ${o.file}  ${o.lines} 行  零引用  ${tag}`);
    }
  }
  if (process.argv.includes("--report")) process.exit(0);
  if (bad.length) {
    console.log(`\n[orphan-scan] ${bad.length} 个零引用模块 —— 删掉，或接线，别留着。`);
    console.log(`[orphan-scan] 死代码里写死的标准名会让「还剩多少处写死」这个数虚高。`);
    process.exit(1);
  }
}
