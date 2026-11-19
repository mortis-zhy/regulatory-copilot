/**
 * **多模态索引** —— 取证工具要用的那一份「图 / 表 / 公式」跨版对照。
 *
 * ## 为什么单独一个模块
 *
 * 附录 B.5（图 / 表 / 公式的跨版对比）**只在报告里** ✗ ——
 * 客户在聊天里问「B 的 p30 那张图和 A 的差在哪」，agent 答不了 ✗。
 * 所以这里把同一套判据**接进取证工具** ✓。
 *
 * ## 一份实现
 *
 * 报告与工具**用同一份代码**（`multimodal.ts` 的 `buildInventory` / `diffVersions`）✓ ——
 * 两边答案不会打架 ✓（工具说「近似」而报告说「一致」= 自己打自己 ✗）。
 *
 * ## 数据从哪来（**不重抽图** ✗）
 *
 * - 图清单：**`reports/figure-hashes.json`** ✓（图版里真有这张图的证据 ✓）
 *   —— 报告渲染时才会去源 PDF 抽位图（慢 ✓），工具这边**不抽** ✓；
 * - pHash：同一份哈希文件 ✓；
 * - 图内文字 OCR：`reports/figure-ocr.json` ✓；
 * - 人工标注：`data/figure-limits.json` ✓；
 * - 表 / 公式：`dist/mineru-v4-data.json` ✓。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../_core/projectRoot";
import {
  buildInventory,
  diffVersions,
  type MultimodalInventory,
  type VersionDiff,
} from "./multimodal";

const ROOT = PROJECT_ROOT;

export type MultimodalIndex = {
  /** 有素材的版本 ✓ */
  versions: string[];
  inventory: Record<string, MultimodalInventory>;
  /** 每一对版本的对照 ✓ */
  diffs: VersionDiff[];
  /** 素材对比**能不能做** ✓ —— 不能就说清为什么 ✗（不猜 ✗） */
  available: boolean;
  reason?: string;
};

let _idx: MultimodalIndex | null = null;

function readJson(rel: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 取（并缓存）多模态索引 ✓。
 *
 * 缓存的理由：图/表的清单每次重算都要读 11 MB 的语料 ✓ ——
 * 一次问答里调两三个工具，不该重复解析 ✓。
 */
export function multimodalIndex(): MultimodalIndex {
  if (_idx) return _idx;
  const corpus = readJson("dist/mineru-v4-data.json");
  if (!corpus) {
    _idx = {
      versions: [],
      inventory: {},
      diffs: [],
      available: false,
      reason: "没有 dist/mineru-v4-data.json（语料还没抽）—— 本次不答素材对比",
    };
    return _idx;
  }
  const hashes = readJson("reports/figure-hashes.json") ?? {};
  const ocr = readJson("reports/figure-ocr.json")?.images ?? null;
  const limitRows = readJson("data/figure-limits.json")?.rows ?? [];
  const limits: Record<string, any> = {};
  for (const r of limitRows) {
    if (!r?.figure) continue;
    limits[String(r.figure)] = {
      values: r.values ?? [],
      caption: r.caption ?? "",
      depicts: r.depicts ?? "",
      valueBasis: r.valueBasis ?? "",
      adjudicated: !!r.adjudicated,
      annotator: r.annotator ?? "",
    };
  }

  const versions = Object.keys(corpus).filter((v) => corpus[v]?.sourceSha256);
  const inventory: Record<string, MultimodalInventory> = {};
  for (const v of versions) {
    const sha = String(corpus[v].sourceSha256);
    const dir = `dist/figures/${sha.slice(0, 8)}`;
    // 图清单从**哈希文件**推 ✓ —— 它是「图版里真有这张图」的证据 ✓。
    // 页码从文件名 `p<page>_<i>.png` 里读 ✓（不用再开 PDF ✓）。
    const pages: Record<string, Array<{ file: string; w: number; h: number }>> = {};
    for (const [rel, meta] of Object.entries(hashes)) {
      if (!rel.startsWith(`${dir}/`)) continue;
      const m = /\/p(\d+)_\d+\.png$/.exec(rel);
      if (!m) continue;
      (pages[m[1]] ??= []).push({
        file: rel.slice(dir.length + 1),
        w: Number(meta?.w ?? 0),
        h: Number(meta?.h ?? 0),
      });
    }
    inventory[v] = buildInventory(v, corpus[v], hashes, { dir, pages }, ocr, limits);
  }

  const diffs: VersionDiff[] = [];
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      diffs.push(diffVersions(inventory[versions[i]], inventory[versions[j]]));
    }
  }
  _idx = { versions, inventory, diffs, available: true };
  return _idx;
}

/** 某一对版本的对照 ✓（顺序无关 ✓）。 */
export function diffOf(a: string, b: string): VersionDiff | null {
  const idx = multimodalIndex();
  return (
    idx.diffs.find((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a)) ?? null
  );
}

/* ------------------------------------------------------------------------- */
/* 反查：这一版有哪些图、每张图讲什么、别版里有没有近似孪生                   */
/* ------------------------------------------------------------------------- */

/** 一张图（供取证工具反查用 ✓）。 */
export type FigureEntry = {
  version: string;
  page: number;
  file: string;
  /** 感知指纹（有 pHash 才能配对 ✓） */
  phash: string;
  /** OCR 读到的几处文字（**会读错** ✗） */
  ocrText: string[];
  /** 人工标注（没有 = 没标注 ✗，不是「图里没限值」✗） */
  limits?: {
    values: string[];
    caption: string;
    depicts: string;
    adjudicated: boolean;
    visualOnly: boolean;
  };
  /** 其它版本里的**近似**孪生 ✓（近似 ≠ 同一 ✗） */
  twins: Array<{ version: string; page: number; distance: number }>;
};

/**
 * 某一版的图清单 ✓（可按页 / 关键词筛 ✓）。
 *
 * 「孪生」= 别的版本里**图像近似**的那张 ✓ —— 不是「同一张」的证明 ✗，
 * 也不是「这一版多了/少了这张图」的结论 ✗。
 */
export function figuresOf(version: string, page?: number, keyword?: string): FigureEntry[] {
  const idx = multimodalIndex();
  const inv = idx.inventory[version];
  if (!inv) return [];
  // 孪生表：图路径 → 别的版本里的近似图 ✓
  const twins = new Map<string, Array<{ version: string; page: number; distance: number }>>();
  for (const d of idx.diffs) {
    for (const p of d.figures.paired) {
      const push = (file: string, t: { version: string; page: number; distance: number }) => {
        const arr = twins.get(file) ?? [];
        arr.push(t);
        twins.set(file, arr);
      };
      push(p.left.file, { version: d.b, page: p.right.page, distance: p.distance });
      push(p.right.file, { version: d.a, page: p.left.page, distance: p.distance });
    }
  }
  const kw = String(keyword ?? "").trim();
  const out: FigureEntry[] = [];
  for (const f of inv.figures) {
    if (page != null && f.page !== page) continue;
    const ocrText = (f.ocr ?? [])
      .filter((i) => Number(i.conf) >= 0.6)
      .map((i) => i.text)
      .slice(0, 8);
    const limits = f.limits
      ? {
          values: f.limits.values ?? [],
          caption: f.limits.caption ?? "",
          depicts: f.limits.depicts ?? "",
          adjudicated: !!f.limits.adjudicated,
          visualOnly: !String(f.limits.valueBasis ?? "").trim(),
        }
      : undefined;
    if (kw) {
      const hay = [ocrText.join(" "), limits?.caption ?? "", limits?.depicts ?? "", ...(limits?.values ?? [])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(kw.toLowerCase())) continue;
    }
    out.push({
      version,
      page: f.page,
      file: f.file,
      phash: f.phash,
      ocrText,
      limits,
      twins: twins.get(f.file) ?? [],
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 公式符号表                                                                */
/* ------------------------------------------------------------------------- */

export type SymbolLedgerFile = {
  blocks: Array<{
    version: string;
    page: number;
    symbols: Array<{ symbol: string; definition: string; unit: string }>;
  }>;
};

/** 公式符号表（`data/formula-symbols.json`）✓ —— 没有就说清没有 ✗。 */
export function symbolLedger(): SymbolLedgerFile | null {
  const raw = readJson("data/formula-symbols.json");
  return raw && Array.isArray(raw.blocks) ? (raw as SymbolLedgerFile) : null;
}
