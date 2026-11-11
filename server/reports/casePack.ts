/**
 * **案例包** —— 「通用流程」与「这一套标准的专用资料」的分界。
 *
 * ## 这道分界为什么必须有
 *
 * 这个项目里有两类东西：
 *
 * | | 是什么 | 换一套标准时 |
 * |---|---|---|
 * | **通用流程** | 上传 → 认版本 → 提取条款 → 找对应 → 比差异 → 标页码 → 出报告 | **不用改** |
 * | **案例资料** | 哪些章节讨论远光灯、哪些参数是安装高度、GB↔R48 的章节对应、人工核对过的结论 | **要重做** |
 *
 * 它们以前**混在一起**：报告生成时**不看输入是谁**，直接把案例资料套上去。
 * 于是上传一份**完全不同的法规**，报告里照样会出现
 * 「GB 与 UN R48 的章节对应」「9 条声称指标」「远光灯安装高度」——
 * **一本正经地讲错标准**，而读者分不出来。
 *
 * （同事在 GitHub issue #5 提的就是这一条。）
 *
 * ## 这里的机制
 *
 * `data/standard-pack.json` **就是**那个案例包（它本来就是
 * 「关于这个标准，报告需要知道的一切」）。这份文件现在多说了两件事：
 *
 * - `casePack` —— 这个案例包**是什么**；
 * - `versions[].sourceSha256` —— 它**管哪些文件**（源文件指纹）。
 *
 * 出稿前先问一句：**这份输入是不是本案例包管的文件？**
 *
 * - 是 → 套用案例资料 ✓；
 * - 不是 → **拒绝出完整对比**，并说清「尚未配置」
 *   （宁可空着，不可错着 —— 编一份完整的对比，比不给更坏）。
 *
 * ## 支持另一套法规要做什么
 *
 * **加一个案例包**（一份声明 + 一组数据文件），**不必把程序重新改一遍** ✓。
 */
import fs from "node:fs";
import path from "node:path";

import PACK_JSON from "../../data/standard-pack.json";
import { PROJECT_ROOT } from "../_core/projectRoot";
import { RECOGNIZE_SAME_VERSION } from "./versionRecognize";
import { fingerprint, sampleAcross, similarity } from "./textFingerprint";
import { loadReferenceTexts } from "./versionRecognize";

/** 比对时取多少字符（与认版本那一套同一口径 ✓）。 */
const WINDOW = 20000;

/**
 * 「族内再判一次」的相似度下限。
 *
 * 实测（2026-11-09）：
 * - 同一份文件的另一个副本（3% 字符噪声 + 8% 段落丢失）→ **0.43**
 * - 同一套标准的**兄弟版本** → 0.52
 * - **跨标准** → 0.14–0.16
 *
 * 所以 0.7 那个阈值只对**干净副本**成立 —— 有 OCR 噪声就塌 ✗。
 * 0.30 压在**跨标准**（0.14–0.16）之上、噪声副本（0.43）之下 ✓，
 * 再配上**文件名签名**（族内判别器 ✓）才敢用这一档 ✓。
 */
const SIMILARITY_FAMILY = 0.3;

/**
 * 文件名签名 —— **声明里那一份**（`versions[].fileTokens` / `fileExclude`）✓。
 *
 * 与 sidecar 判版本用的是同一份声明 ✓（不另写一套正则 ✓）。
 * 签名认的是「族内」的身份（草案 vs 现行 ✓）——
 * 跨标准的文件**匹配不上任何一版**的签名 ✓（除非文件名是伪造的 ✓，
 * 而伪造的文件名救不了它的正文相似度 ✓）。
 */
function signatureMatches(version: any, name: string): boolean {
  const tokens: string[] = version.fileTokens ?? [];
  const exclude: string[] = version.fileExclude ?? [];
  if (!tokens.length) return false;
  const hay = String(name ?? "");
  if (!hay) return false;
  const all = tokens.every((t) => {
    try {
      return new RegExp(t, "i").test(hay);
    } catch {
      return false;
    }
  });
  if (!all) return false;
  return !exclude.some((x) => {
    try {
      return new RegExp(x, "i").test(hay);
    } catch {
      return false;
    }
  });
}

/** 一份待判定的输入。 */
export type CasePackDoc = {
  /** 版本键（A/B/C…）。 */
  key: string;
  /** 源文件指纹（sha256）。 */
  sha256?: string;
  /** 抽取出来的正文 —— 指纹对不上时用它比内容。 */
  text?: string;
  /** 文件名 —— 相似度不够时，用**声明里的签名**在族内再判一次 ✓。 */
  name?: string;
};

export type CasePackDocMatch = {
  key: string;
  /** 认成了哪一版；认不出是 null。 */
  matchedTo: string | null;
  by: "sha256" | "content" | "none";
  score: number;
  /** 人话版的理由（进错误信息 ✓）。 */
  note: string;
};

export type CasePackMatch = {
  /** 这份输入是不是本案例包管的？ */
  applies: boolean;
  casePackId: string;
  family: string;
  perDoc: CasePackDocMatch[];
  /** 不适用时：人话版的说明（可直接给用户看 ✓）。 */
  reason: string;
};

/** 「这套标准尚未配置」—— 单独一个错误类型，端点据此回 422 而不是 500 ✓。 */
export class CasePackNotConfiguredError extends Error {
  readonly code = "case_pack_not_configured";
  readonly decision: CasePackMatch;
  constructor(decision: CasePackMatch) {
    super(decision.reason);
    this.name = "CasePackNotConfiguredError";
    this.decision = decision;
  }
}

// ---- 语料（内容比对时的参照物） ------------------------------------------

let CORPUS_CACHE: { at: number; data: Record<string, any> } | null = null;

/** 读语料（按 mtime 缓存 —— 11 MB，每次重读太慢 ✓）。 */
function corpus(): Record<string, any> {
  const p = path.join(PROJECT_ROOT, "dist", "mineru-v4-data.json");
  try {
    const st = fs.statSync(p);
    if (!CORPUS_CACHE || CORPUS_CACHE.at !== st.mtimeMs) {
      CORPUS_CACHE = { at: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, "utf-8")) };
    }
    return CORPUS_CACHE.data;
  } catch {
    return {};
  }
}

/** 某一版的参照正文（语料里那一版的抽取文本 ✓ —— 与上传件**同一种表示**）。 */
function referenceText(key: string): string | null {
  const doc = corpus()[key];
  const t = doc?.fullText;
  return typeof t === "string" && t.length > 0 ? t : null;
}

// ---- 判定 ----------------------------------------------------------------

/**
 * 这份输入是不是本案例包管的文件？
 *
 * 两级判据（与「认版本」同一套口径 ✓）：
 *
 * ① **指纹完全一致** —— 上传的文件就是抽取时用的那一份。零歧义、最常见。
 * ② **内容相似度** —— 同一份标准的另一个副本（重新扫描/转存过）。
 *    拿**同一种表示**互比（两边都是抽取后的正文）——
 *    跨表示互比会被排版差异压到 0.2 上下，判据会失去区分力。
 */
/**
 * 案例包管的**源文件名**（按版本键）。
 *
 * 完成标准 1：「每条回答证据能回到**当前任务的文件**、条款和页码」——
 * 光给版本代号（A/B/C）不够：读者要能知道**翻哪个文件**。
 */
export function casePackSourceFiles(): { key: string; fileName: string }[] {
  const versions = (PACK_JSON as any)?.versions ?? [];
  return versions.map((v: any) => ({ key: String(v.key ?? ""), fileName: String(v.sourceFile ?? "") }));
}

/**
 * 正文里的**限值**（数 + 单位）—— 用来判「这份输入是不是核验时的那一份」。
 *
 * ## 为什么要有
 *
 * 同事 2026-11-10 复核发现 ✗：
 * 「把一处 75 mm 改成 999999 mm，匹配函数仍返回适用，相似度为 1」。
 *
 * 相似度是**字符二元组**的比 ✓ —— 改一个数几乎不动它 ✓（1.00 ✓），
 * 所以**相似度高 ≠ 这份文件还是那一份** ✗。
 *
 * 而**限值**正是「人工核过的结论」所依赖的东西 ✓ ——
 * 结论是按**具体数值**核的 ✓，数值变了，结论就不能直接用 ✓。
 *
 * ## 抓的是**集合差**，不是比例
 *
 * 改 1 个值 / 300 个 = 99.7% ✓ —— 任何比例阈值都抓不到 ✗。
 * 「参考件里的每一个限值都必须在这份输入里出现」✓ 才抓得到 ✓。
 *
 * OCR 噪声造成的漏检怎么办 ✓：**由人看** ✓ ——
 * 错误信息里**点名**了缺哪几个 ✓（「是 OCR 掉了，还是这份不一样？」✓）。
 */
export function anchorCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /(\d[\d.,]*)\s*(㎜|cm2|㎡|cm|mm|m2|cd|lx|lm|hz|ms|rad|°|º|%|m|s)/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const num = m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(/[.,]$/, "");
    if (!num || num === ".") continue;
    const unit = String(m[2])
      .replace(/㎜/g, "mm")
      .replace(/㎝/g, "cm")
      .replace(/㎡/g, "m2")
      .replace(/º/g, "°")
      .toLowerCase();
    const key = `${num}${unit}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** 限值的**去重集合**（老接口，保留给别处用 ✓）。 */
export function anchorValues(text: string): Set<string> {
  return new Set(anchorCounts(text).keys());
}

/**
 * 限值的**宽松匹配** —— OCR 掉一位算对上 ✓，换了数字算对不上 ✗。
 *
 * ## 为什么不能严格相等
 *
 * 噪声副本（3% 字符被换掉 + 8% 段落丢失 ✓）里**大量**限值读不出来 ✗ ——
 * 严格相等会把「客户上传自己那份」的情形也拒掉 ✗。
 *
 * ## 判据：**数字的每一位都要在对方里出现** ✓
 *
 * - 参考件 `75mm` · 噪声副本 `7mm`（掉了一位 ✓）→ 「7」两边都有 ✓ → **对上** ✓；
 * - 参考件 `75mm` · 改过的副本 `999999mm` → 一位都对不上 ✗ → **对不上** ✓；
 * - 参考件 `75mm` · 改过的副本 `80mm` → 位数相同也没用 ✗ → **对不上** ✓
 *   （**数字不一样就是不一样** ✓ —— 这正是「人工结论按数值核」的含义 ✓）。
 */
export function findLoosePartner(ref: string, pool: Map<string, number>): string | null {
  const rm = /^(\d+(?:\.\d+)?)(.*)$/.exec(ref);
  if (!rm) return null;
  const digits = rm[1].replace(/\D/g, "");
  const unit = rm[2];
  if (!digits) return null;
  const a = new Set(digits.split(""));
  for (const [cand, count] of pool) {
    if (!count) continue;
    if (!cand.endsWith(unit)) continue;
    const cm = /^(\d+(?:\.\d+)?)/.exec(cand);
    if (!cm) continue;
    const cd = cm[1].replace(/\D/g, "");
    if (!cd) continue;
    // **子序列**判据 ✓ —— OCR 掉的数字还**留着、顺序也没变** ✓
    //   `75` → `7` ✓（子序列 ✓）→ 同一个数 ✓；
    //   `75` → `350` ✗（不是子序列 ✓）→ 另一个数 ✓；
    //   `75` → `999999` ✗ → 改了的数 ✓。
    if (isSubsequence(cd, digits)) return cand;
  }
  return null;
}

/** `b` 是不是 `a` 的**子序列** ✓（顺序不变、可以不连续 ✓）。 */
function isSubsequence(b: string, a: string): boolean {
  if (!b.length) return false;
  let i = 0;
  for (const ch of a) {
    if (ch === b[i]) i++;
    if (i === b.length) return true;
  }
  return false;
}

/** 单位写法统一 —— 只动写法，不动内容 ✓。 */
function normTextForCompare(t: string): string {
  return String(t ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/,/g, "")
    .toLowerCase();
}

export async function matchCasePack(docs: CasePackDoc[]): Promise<CasePackMatch> {
  const pack = PACK_JSON as any;
  const cp = pack.casePack ?? {};
  const versions: any[] = pack.versions ?? [];
  const perDoc: CasePackDocMatch[] = [];

  for (const doc of docs ?? []) {
    // ① 指纹
    const bySha = versions.find(
      (v) => v.sourceSha256 && doc.sha256 && v.sourceSha256 === doc.sha256,
    );
    if (bySha) {
      perDoc.push({
        key: doc.key,
        matchedTo: bySha.key,
        by: "sha256",
        score: 1,
        note: `指纹与 ${bySha.key} 版（${bySha.doc}）完全一致`,
      });
      continue;
    }

    // ② 内容相似度 —— 与**每一版**的参照正文比，取最像的那一版
    //
    // **两种表示**都试 ✓（同事 2026-11-10 复核发现 ✗）：
    //   · 语料里的 **MinerU** 文本 ✓；
    //   · 源 PDF 的 **MuPDF** 文本 ✓ —— 上传件的服务端抽取就是 MuPDF ✓，
    //     **同一种表示互比**才有区分力 ✓（跨表示只有 0.2 上下 ✗）。
    let best: { v: any; score: number; ref: string } | null = null;
    for (const v of versions) {
      const refs: string[] = [];
      const mineru = referenceText(v.key);
      if (mineru) refs.push(mineru);
      const mupdf = (await loadReferenceTexts()).find((r) => r.label === v.key)?.text;
      if (mupdf) refs.push(mupdf);
      for (const ref of refs) {
        if (!doc.text) continue;
        const score = similarity(
          fingerprint(sampleAcross(doc.text, 0), WINDOW),
          fingerprint(sampleAcross(ref, 0), WINDOW),
        );
        if (!best || score > best.score) best = { v, score, ref };
      }
    }
    if (best) {
      // **限值核对** ✓ —— 相似度高**不等于**「还是那一份」✗
      // （同事 2026-11-10：把 75 mm 改成 999999 mm，相似度仍是 1 ✗）。
      //
      // 判据是**对不上的比例** ✓：
      //   · **大量**对不上（> 2%）→ **OCR 噪声** ✓ → 接受 ✓
      //     （客户上传自己那份的情形 ✓：实测 3% 字符噪声 + 8% 段落丢失 ✓）；
      //   · **少量**对不上但**不为 0**（≤ 2%）→ **这份被改过** ✗ → 拒绝 ✓
      //     （人工结论是按**具体数值**核的 ✓，数值变了就不能直接用 ✓）。
      // **按出现次数**比 ✓ —— 同一个值在别处还有 ✓，
      // 只改一处的话，**集合**看不出来 ✗（次数看得出来 ✓）。
      const refCounts = anchorCounts(best.ref);
      const pool = doc.text ? new Map(anchorCounts(doc.text)) : new Map<string, number>();
      const missing: string[] = [];
      let missingCount = 0;
      let refTotal = 0;
      for (const [anchor, need] of refCounts) {
        refTotal += need;
        let left = need;
        // ① 精确的 ✓
        const exact = pool.get(anchor) ?? 0;
        if (exact > 0) {
          pool.set(anchor, exact - 1);
          left -= 1;
        }
        // ② 宽松的（OCR 掉了一位 ✓）
        while (left > 0) {
          const sub = findLoosePartner(anchor, pool);
          if (!sub) break;
          pool.set(sub, (pool.get(sub) ?? 1) - 1);
          left -= 1;
        }
        if (left > 0) {
          missingCount += left;
          missing.push(anchor);
        }
      }
      const ratio = refTotal ? missingCount / refTotal : 0;
      if (missing.length && ratio <= 0.02) {
        perDoc.push({
          key: doc.key,
          matchedTo: null,
          by: "none",
          score: best.score,
          note:
            `最像的是 ${best.v.key} 版（${best.v.doc}），相似度 ${best.score.toFixed(2)}，` +
            `但**有 ${missingCount} 个限值在这份文件里对不上**` +
            `（如 ${missing.slice(0, 3).join("、")}）—— 这份文件的内容与核验时的那份**不是一回事**` +
            `（人工结论是按具体数值核的 ✓，数值变了就不能直接用 ✓）`,
        });
        continue;
      }
      if (missing.length) {
        // OCR 噪声 ✓ —— 接受 ✓，但**说出来** ✓（不静默 ✓）。
        console.warn(
          `[case-pack] ${best.v.key} 版：${missingCount}/${refTotal} 个限值对不上` +
            `（${(ratio * 100).toFixed(1)}%）—— 按 OCR 噪声处理 ✓`,
        );
      }
      if (best.score >= RECOGNIZE_SAME_VERSION) {
        perDoc.push({
          key: doc.key,
          matchedTo: best.v.key,
          by: "content",
          score: best.score,
          note: `内容与 ${best.v.key} 版（${best.v.doc}）相似度 ${best.score.toFixed(2)}`,
        });
      } else if (
        best.score >= SIMILARITY_FAMILY &&
        signatureMatches(best.v, doc.name ?? "")
      ) {
        // 相似度被 OCR 噪声吃掉了，但**文件名签名**对得上 ——
        // 签名是**族内**的判别器（草案 vs 现行 ✓），
        // 相似度是**族间**的判别器 ✓（跨标准只有 0.14–0.16 ✓）。
        perDoc.push({
          key: doc.key,
          matchedTo: best.v.key,
          by: "content",
          score: best.score,
          note:
            `内容与 ${best.v.key} 版（${best.v.doc}）相似度 ${best.score.toFixed(2)}` +
            `（噪声吃掉了相似度，但**文件名签名**对得上）`,
        });
      } else {
        perDoc.push({
          key: doc.key,
          matchedTo: null,
          by: "none",
          score: best.score,
          note:
            `最像的是 ${best.v.key} 版（${best.v.doc}），但相似度只有 ${best.score.toFixed(2)}` +
            `（同一份标准要 ≥ ${RECOGNIZE_SAME_VERSION}）`,
        });
      }
      continue;
    }

    perDoc.push({
      key: doc.key,
      matchedTo: null,
      by: "none",
      score: 0,
      note: "既没有可比对的指纹，也没有可比对的正文",
    });
  }

  const applies = perDoc.length > 0 && perDoc.every((d) => d.matchedTo !== null);
  const reason = applies ? "" : notConfiguredReason(perDoc, cp, pack);
  return {
    applies,
    casePackId: String(cp.id ?? ""),
    family: String(cp.standardFamily ?? pack.standardFamily ?? ""),
    perDoc,
    reason,
  };
}

/** 不适用时的人话说明 —— 端点会把它**原样**给用户看 ✓。 */
function notConfiguredReason(
  perDoc: CasePackDocMatch[],
  cp: any,
  pack: any,
): string {
  const family = String(cp.standardFamily ?? pack.standardFamily ?? "这套标准");
  const head =
    String(cp.notConfiguredMessage ?? "").trim() ||
    `这套标准**尚未配置**：本项目的抽取规则、章节映射与人工核对结论都是 **${family}** 这一套的专用资料，不能套到别的法规上。`;
  const lines = perDoc.map((d) => `  · ${d.key}：${d.note}`).join("\n");
  return `${head}\n\n本案例包（${cp.id ?? "?"}）管的文件是：\n${lines}`;
}

/**
 * 不适用就**抛错** —— 不产出报告。
 *
 * 为什么是抛错而不是「出一份没有案例资料的报告」：
 * 报告的结构、标题、章节号全都来自案例包（`standard-pack.json`）——
 * 拿 GB 4785 的骨架去讲另一套法规，**连标题都是错的**。
 * 半成品比没有更坏：读者以为那就是结论。
 */
export async function assertCasePack(docs: CasePackDoc[]): Promise<CasePackMatch> {
  const decision = await matchCasePack(docs);
  if (!decision.applies) throw new CasePackNotConfiguredError(decision);
  return decision;
}
