/**
 * 报告的**上游指纹** —— 这份报告是从哪几份文件算出来的。
 *
 * ## 为什么要有它
 *
 * 交付链是：
 *
 *     extract-cache ─(LLM 抽取)─> diff-result.json ─(程序化 diff)─> facts.json
 *          └─(verify_claims.py 回源复核)─> verified-comparison.json
 *                    ↓
 *             reports/last-report.json ─(渲染)─> 交付件 PDF
 *
 * 每一段都是**确定性**的（除了第一段的 LLM 抽取），
 * 所以「上游变了，下游没跟着变」是**可以判定的**——
 * 只要把上游的指纹记进下游。
 *
 * 实测（2026-11-04）三处接缝里，**一处都没判**：
 *   · 改了 `dist/extract-cache/*.json` 里的一个条款号 → 闸门 131/131 全绿；
 *   · 把交付件 PDF 换成 249 页的旧版 → 闸门 131/131 全绿；
 *   · 改 `data/diff-corrections.json` 里的人工更正 → **抓到了**（差值那一半有判据）。
 *
 * 所以这里补上「指纹」这一层：报告里记着上游的 sha256，
 * 闸门比对「报告里记的」与「磁盘上现在的」——
 * 对不上就说明**这份报告是用旧上游算出来的**。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Provenance = {
  /** facts.json（核验后的唯一事实表） */
  factsSha256: string;
  /** diff-result.json（程序化差值） */
  diffResultSha256: string;
  /** 每一份 extract-cache 的 sha256（键 = 文件名） */
  extractCacheSha256: Record<string, string>;
  /** 生成这份报告的时刻（ISO） */
  builtAt: string;
};

const sha256 = (abs: string): string => {
  try {
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "";
  }
};

/**
 * 算当前上游的指纹。文件不在就留空字符串 ——
 * 空 = 「没有这个上游」，闸门会据此判断该报什么错。
 */
export function computeProvenance(root: string): Provenance {
  const cacheDir = path.join(root, "dist", "extract-cache");
  const cache: Record<string, string> = {};
  try {
    for (const f of fs.readdirSync(cacheDir).sort()) {
      if (!/^v3-.*\.json$/.test(f)) continue;
      cache[f] = sha256(path.join(cacheDir, f));
    }
  } catch {
    /* 缓存目录不存在 → 空表 */
  }
  return {
    factsSha256: sha256(path.join(root, "dist", "facts.json")),
    diffResultSha256: sha256(path.join(root, "diff-result.json")),
    extractCacheSha256: cache,
    builtAt: new Date().toISOString(),
  };
}

/** 两份指纹是否一致（**不比 builtAt** —— 它每次都不一样）。 */
export function sameProvenance(a: Provenance | undefined, b: Provenance | undefined): boolean {
  if (!a || !b) return false;
  if (a.factsSha256 !== b.factsSha256) return false;
  if (a.diffResultSha256 !== b.diffResultSha256) return false;
  const ka = Object.keys(a.extractCacheSha256 ?? {}).sort();
  const kb = Object.keys(b.extractCacheSha256 ?? {}).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a.extractCacheSha256[ka[i]] !== b.extractCacheSha256[kb[i]]) return false;
  }
  return true;
}

/** 把差异讲成人话（闸门报错时用）。 */
export function describeProvenanceDiff(
  a: Provenance | undefined,
  b: Provenance | undefined,
): string[] {
  const out: string[] = [];
  if (!a) return ["报告里没有记上游指纹 —— 这份报告不是带溯源信息生成的"];
  if (!b) return ["磁盘上读不到上游文件"];
  if (a.factsSha256 !== b.factsSha256) {
    out.push(`dist/facts.json 变了（报告记的是 ${a.factsSha256.slice(0, 12)}…，现在是 ${b.factsSha256.slice(0, 12)}…）`);
  }
  if (a.diffResultSha256 !== b.diffResultSha256) {
    out.push(`diff-result.json 变了（报告记的是 ${a.diffResultSha256.slice(0, 12)}…，现在是 ${b.diffResultSha256.slice(0, 12)}…）`);
  }
  const ka = Object.keys(a.extractCacheSha256 ?? {});
  const kb = Object.keys(b.extractCacheSha256 ?? {});
  for (const k of ka) {
    if (!(k in (b.extractCacheSha256 ?? {}))) out.push(`extract-cache/${k} 现在没了`);
    else if (a.extractCacheSha256[k] !== b.extractCacheSha256[k]) {
      out.push(`extract-cache/${k} 变了（${a.extractCacheSha256[k].slice(0, 12)}… → ${b.extractCacheSha256[k].slice(0, 12)}…）`);
    }
  }
  for (const k of kb) {
    if (!ka.includes(k)) out.push(`extract-cache/${k} 是新的 —— 报告里没有它`);
  }
  return out;
}
