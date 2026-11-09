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

/** 比对时取多少字符（与认版本那一套同一口径 ✓）。 */
const WINDOW = 20000;

/** 一份待判定的输入。 */
export type CasePackDoc = {
  /** 版本键（A/B/C…）。 */
  key: string;
  /** 源文件指纹（sha256）。 */
  sha256?: string;
  /** 抽取出来的正文 —— 指纹对不上时用它比内容。 */
  text?: string;
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
export function matchCasePack(docs: CasePackDoc[]): CasePackMatch {
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
    let best: { v: any; score: number } | null = null;
    for (const v of versions) {
      const ref = referenceText(v.key);
      if (!ref || !doc.text) continue;
      const score = similarity(
        fingerprint(sampleAcross(doc.text, 0), WINDOW),
        fingerprint(sampleAcross(ref, 0), WINDOW),
      );
      if (!best || score > best.score) best = { v, score };
    }
    if (best) {
      if (best.score >= RECOGNIZE_SAME_VERSION) {
        perDoc.push({
          key: doc.key,
          matchedTo: best.v.key,
          by: "content",
          score: best.score,
          note: `内容与 ${best.v.key} 版（${best.v.doc}）相似度 ${best.score.toFixed(2)}`,
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
export function assertCasePack(docs: CasePackDoc[]): CasePackMatch {
  const decision = matchCasePack(docs);
  if (!decision.applies) throw new CasePackNotConfiguredError(decision);
  return decision;
}
