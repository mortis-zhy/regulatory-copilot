#!/usr/bin/env node
/**
 * 扫源码里的「标准特定字面量」—— 换一套标准时**必须改**的那些地方。
 *
 * ## 为什么要有这一关
 *
 * 换标准这件事，这个项目里最贵的不是「spec 包要重写」——
 * spec 集中在一个文件里，看得见。
 * 最贵的是**散落在十几个 .ts/.py 里的字面量**：
 * 一句错误提示、一个 brief、一处文件名模板、一条识别正则。
 *
 * 而漏掉一处的症状**不报错**：那句话照出现在新标准的报告里 / 界面上，
 * 读者会以为那是新标准的规定。**那是「错着」，不是「空着」。**
 *
 * 这一层不报错，是因为**没有任何机制在管它**——
 * 以前的做法是「靠记得」，而「记得」不是机制。
 *
 * ## 这个脚本只回答一个问题
 *
 * > 源码里有哪些地方**写死了「本标准集的名字」**？各是什么性质？
 *
 * 性质分四类，因为它们的**失败方式**不一样：
 *
 * | 类别 | 是什么 | 换标准后不换会怎样 |
 * |---|---|---|
 * | `注释` | 注释、文档字符串 | 没事（只是过时） |
 * | `文案` | 字符串字面量（会出现在输出里） | **静默说错** —— 读者以为那是新标准的规定 |
 * | `判据` | 正则 / 模式（用来认输入） | **响亮失败** —— 认不出新标准的文件 |
 * | `标识符` | 代码里的名字（变量、键） | 响亮失败或无害 |
 *
 * 判据与文案的区别是这张表的核心：
 * **判据错了会响，文案错了只会骗人。**
 *
 * ## 输出
 *
 * JSON 数组（stdout），每条：
 * ```
 * { file, line, col, cls, kind, sub, text, excerpt }
 * ```
 * - `cls`  —— 命中的是哪一类标准名（gb4785 / gb4785-2019 / un-r48 / ece-r48 / v4-3-5）
 * - `kind` —— comment / string / code
 * - `sub`  —— 注释 / 文案 / 判据 / 标识符
 * - `text` —— 所在那个字面量的全文（kind=string 时是去掉引号的内容）
 * - `excerpt`—— 所在那一行的缩进后文本（人看的）
 *
 * 用法
 * ----
 *     node scripts/hardcode_scan.mjs            # 打印 JSON
 *     node scripts/hardcode_scan.mjs --summary  # 只打印统计
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 要扫的目录（**产品代码**）。`data/` 不扫 —— 那些本来就是声明。 */
const SCAN_DIRS = ["server", "client/src", "shared", "python_service", "scripts", "tools"];
/** 仓库根的散装源码。 */
const ROOT_FILES = ["unit-test.ts", "rebuild_report.mjs", "render_to_pdfdir.mjs"];
/** 这些扩展名是 JS/TS 侧的；.py 由 scripts/hardcode_scan.py 扫。 */
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * 标准名的形态。
 *
 * ## 为什么分隔符要写成这么复杂的东西
 *
 * 因为**判据里往往把标准名拆进正则里**：
 * `GB[\s_-]*4785`、`UN[\s_-]*R0?48`、`V4\.3\.5` ——
 * 这些字符串**不含**「GB 4785」这个子串，只按字面找会**整类漏掉**，
 * 而这一类恰恰是「换标准后认不出新文件」的判据。
 *
 * 所以这里允许标准名的各部分之间夹着：
 *   · 普通空白 / 下划线 / 破折号
 *   · 反斜杠转义（`\s`、`\.`）
 *   · 字符类（`[\s_-]`）
 *   · 量词（`*`、`+`、`?`）
 *   · **可选的前导零**（`R0?48` —— 号是 48，前面那个 0 是可选的）
 *
 * 「先长后短」很重要：`GB 4785-2019` 必须先于 `GB 4785` 匹配，
 * 否则版本号会漏在字面量的尾巴上（那正是「脚注粘连」的同一种病）。
 *
 * **这段正则必须与 scripts/hardcode_scan.py 里的那份保持一致** ——
 * 两边扫的是同一个仓库，口径不一致就会出现「一边有、一边没有」。
 */
const SEP = String.raw`(?:\\[a-zA-Z]|\[[^\]]*\]|0\??|[\s_\-—–*+?])*`;
const TOKEN_RE = new RegExp(
  `GB${SEP}4785${SEP}(?:[-—–]${SEP}2019)?(?![\\d.])` +
    `|UN${SEP}R${SEP}0?48(?![\\d])` +
    `|ECE${SEP}R${SEP}0?48(?![\\d])` +
    `|V${SEP}4${SEP}3${SEP}5(?![\\d])`,
  "g",
);

/** 把命中的文本归到「哪一类标准名」。 */
function classOf(txt) {
  if (/^GB/.test(txt)) return /2019/.test(txt) ? "gb4785-2019" : "gb4785";
  if (/^UN/.test(txt)) return "un-r48";
  if (/^ECE/.test(txt)) return "ece-r48";
  return "v4-3-5";
}

/**
 * 正则的味道 —— 用来区分「判据」与「文案」。
 *
 * 判据错了会响（认不出文件），文案错了只会骗人（说错标准）。
 * 所以判据宁可**多判**，文案**不许漏判** —— 于是：
 *   · 有反斜杠 / `(?=` / `^` / `$` / `{数字}` → 判据；
 *   · **超过 200 字的** → 一律文案（长散文与提示词不是判据）。
 *
 * 「一律文案」是刻意的：把一段提示词误判成「判据」，
 * 等于把它从重点盯的类别里拿掉 —— 那是**危险的那一侧**。
 */
function looksLikeMatcher(text) {
  const t = String(text || "");
  if (t.length > 200) return false;
  return /\\|\(\?[=!<]|\{\d|[\^$]/.test(t);
}

/** 递归收集要扫的文件。 */
function collectFiles() {
  const out = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (e === "node_modules" || e === "dist" || e === "__pycache__" || e.startsWith(".")) continue;
        walk(path.join(p, e));
      }
    } else if (JS_EXT.has(path.extname(p))) {
      out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  return out.sort();
}

/** 每一行起始偏移 → 位置换算。 */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - starts[lo] + 1 };
  };
}

/** 去掉字面量的定界符。 */
function unwrap(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') return raw.slice(1, -1);
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") return raw.slice(1, -1);
  if (raw.length >= 2 && raw[0] === "`" && raw[raw.length - 1] === "`") return raw.slice(1, -1);
  // 模板片段：`abc${  /  }def`
  let s = raw;
  if (s.startsWith("`")) s = s.slice(1);
  else if (s.startsWith("}")) s = s.slice(1);
  if (s.endsWith("${")) s = s.slice(0, -2);
  else if (s.endsWith("`")) s = s.slice(0, -1);
  return s;
}

/**
 * 注释从哪来：AST 里没有注释节点。
 *
 * 用「每个**记号**的前导注释范围」取 —— 记号比节点更全：
 * `ts.forEachChild` **不产出标点**（链式调用里的那个 `.` 就是一个标点），
 * 于是夹在两个 `.replace()` 之间的 `//` 注释会整段漏掉。
 * `getChildren()` 会把标点也给你。
 *
 * 每个注释恰好被**后一个记号**的前导 trivia 覆盖一次 —— 按起点去重即可。
 */
function collectComments(sf, text, addComment) {
  const visit = (node) => {
    for (const c of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      addComment(c.pos, c.end, text.slice(c.pos, c.end));
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
}

/**
 * 用 TS 的**解析器**把一个文件切成「区域」：
 * 每个字符串 / 正则 / JSX 文本 / 注释各占一段，其余算 code。
 *
 * ## 为什么不用词法器（踩过的坑）
 *
 * 词法器（`createScanner`）在 JSX 上会把 `<div>Don't</div>` 里的撇号
 * 当成字符串的开始 —— 然后**一路吞到文件末尾**，
 * 后面所有字面量都变成「一个巨大的字符串」。
 *
 * 症状很隐蔽：扫出来「有字面量」，但每个字面量的内容都是错的。
 *
 * 解析器（`createSourceFile`）不会有这个问题：它是真正的语法分析，
 * 撇号在 JSX 文本里就是文本。
 *
 * ## 注释从哪来
 *
 * AST 里没有注释节点。用「每个节点的前导注释范围」取，
 * 再按起点去重 —— 每个注释恰好被后一个 token 的前导 trivia 覆盖一次。
 */
function regionsOf(text, isTsx) {
  const sf = ts.createSourceFile(
    isTsx ? "scan.tsx" : "scan.ts",
    text,
    ts.ScriptTarget.ES2020,
    /*setParentNodes*/ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const regions = [];
  const commentSeen = new Set();

  const addComment = (pos, end, body) => {
    if (commentSeen.has(pos)) return;
    commentSeen.add(pos);
    regions.push({ start: pos, end, kind: "comment", text: body });
  };

  const visit = (node) => {
    const s = node.getStart(sf);
    const e = node.getEnd();
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      regions.push({ start: s, end: e, kind: "string", text: node.text });
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      regions.push({ start: s, end: e, kind: "string", text: node.text });
    } else if (ts.isRegularExpressionLiteral(node)) {
      regions.push({ start: s, end: e, kind: "regex", text: node.getText(sf) });
    } else if (ts.isJsxText(node)) {
      // JSX 文本**会显示给用户** —— 与字符串字面量同级，不是「裸代码」。
      regions.push({ start: s, end: e, kind: "jsx", text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  collectComments(sf, text, addComment);

  // 文件末尾的注释（前面没有 token 接着它）
  for (const c of ts.getTrailingCommentRanges(text, sf.getEnd()) ?? []) {
    addComment(c.pos, c.end, text.slice(c.pos, c.end));
  }
  return regions;
}

export function scanFile(rel) {
  const abs = path.join(ROOT, rel);
  const text = fs.readFileSync(abs, "utf8");
  const at = lineIndex(text);
  const regions = regionsOf(text, rel.endsWith(".tsx"));
  regions.sort((a, b) => a.start - b.start);

  const lines = text.split(/\r?\n/);
  const out = [];

  /** 落在哪个区域里？返回 null 表示「不在任何字面量/注释里」（即裸代码）。 */
  const regionOf = (pos) => {
    for (const r of regions) {
      if (pos >= r.start && pos < r.end) return r;
      if (r.start > pos) break;
    }
    return null;
  };

  /**
   * **一个字面量算一个硬编码点**，不是一个 token 算一个。
   *
   * 「GB 4785 草案 V4.3.5」这一条里同时含 `GB 4785` 和 `V4.3.5` 两个 token，
   * 但它**只需要改一次** —— 按 token 数会把它算两遍，
   * 清单就会骗人（说有两处要改，其实在同一行）。
   */
  const regionClasses = new Map(); // region.start -> [cls, ...]
  const seenRegions = new Set();
  for (const m of text.matchAll(TOKEN_RE)) {
    const reg = regionOf(m.index);
    if (reg) {
      if (!regionClasses.has(reg.start)) regionClasses.set(reg.start, []);
      regionClasses.get(reg.start).push(classOf(m[0]));
      if (seenRegions.has(reg.start)) continue;
      seenRegions.add(reg.start);
      const { line, col } = at(reg.start);
      let kind;
      let sub;
      if (reg.kind === "comment") {
        kind = "comment";
        sub = "注释";
      } else if (reg.kind === "regex") {
        kind = "string";
        sub = "判据";
      } else if (reg.kind === "jsx") {
        kind = "string";
        sub = "文案";
      } else {
        kind = "string";
        sub = looksLikeMatcher(reg.text) ? "判据" : "文案";
      }
      out.push({
        file: rel,
        line,
        col,
        cls: regionClasses.get(reg.start),
        kind,
        sub,
        text: reg.text,
        excerpt: (lines[line - 1] || "").trim(),
      });
    } else {
      // 裸代码里的（变量名、键名）——没有字面量可依附，逐个记。
      const { line, col } = at(m.index);
      out.push({
        file: rel,
        line,
        col,
        cls: [classOf(m[0])],
        kind: "code",
        sub: "标识符",
        text: null,
        excerpt: (lines[line - 1] || "").trim(),
      });
    }
  }
  return out;
}

export function scanAll() {
  const out = [];
  for (const f of collectFiles()) out.push(...scanFile(f));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("hardcode_scan.mjs")) {
  const recs = scanAll();
  if (process.argv.includes("--summary")) {
    const by = {};
    for (const r of recs) {
      const k = `${r.sub}`;
      by[k] = by[k] || { n: 0, files: new Set() };
      by[k].n++;
      by[k].files.add(r.file);
    }
    console.log(`标准特定字面量 ${recs.length} 处`);
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${k}\t${v.n} 处\t${v.files.size} 个文件`);
    }
  } else {
    console.log(JSON.stringify(recs, null, 1));
  }
}
