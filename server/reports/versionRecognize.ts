/**
 * 「这份上传的文件是哪一版？」—— **按内容认**，不按文件名。
 *
 * ## 为什么这件事值得单独一个模块
 *
 * 项目里认版本有**三套实现**：
 *
 * | 实现 | 判据 | 换标准时 |
 * |---|---|---|
 * | `python_service/main.py` 的 `DOC_SIGNATURES` | **文件名**正则 | 要改代码 |
 * | `scripts/clause_split.py` 的 `VERSION_FINGERPRINTS` | 内容标记 | 要改代码 |
 * | `server/reports/parameterMatrix.ts` 的 `loadSourceCorpus` | **内容相似度** | **不用改** |
 *
 * 第三套最稳，而且**它不写死任何标准名** —— 它拿语料里的每一版去比，
 * 谁最像就是谁。所以「换一套标准」时，认版本这一步**本来就可以零改动**。
 *
 * 而网站那条路用的是**第一套（文件名）** ——
 * 于是：
 *   · 用户把文件改了名（很普通的事）→ 报告生成到一半报 400，
 *     理由是「文件名不匹配」，而**文件内容完全没问题**；
 *   · 换标准时这一处也要改 —— 而它**本可以不用改**。
 *
 * 这里把判据单独拎出来，**上传时就用它**：
 * 用户上传完第一秒就知道「认成哪一版」或「认不出」，
 * 而不是四分钟后看一份矩阵空掉的报告。
 *
 * ## 判据（两级，先准后糙）
 *
 * ① **sha256 完全一致** —— 上传的文件就是语料里那一份。
 *    零歧义、零成本，**最常见的情况**。
 * ② **内容相似度** —— 同一份标准的另一个副本。
 *    拿**源 PDF 的 MuPDF 文本**与上传文件的 MuPDF 文本比 Dice，
 *    **同一种表示互比**。
 *
 * > 为什么必须是「同一种表示」：拿 MinerU 的语料文本去比 MuPDF 的上传文本，
 * > 实测相似度只有 0.21~0.24 —— 那是**两种排版版本**在比，
 * > 天然被压低，判据会失去区分力。
 * > 同表示互比（跨页采样）实测：正确匹配 **1.00**、同标准的兄弟版 **0.52**、跨标准 **0.14~0.16**。
 */
import { fingerprint, sampleAcross, similarity } from "./textFingerprint";

export type VersionGuess = {
  /** 认出的版本键；认不出就是 null。 */
  label: string | null;
  /** 相似度（sha256 命中时是 1）。 */
  score: number;
  /** 第二名（用来提示「两版难分」）。 */
  runnerUp: { label: string; score: number } | null;
  /** 判据来源：sha256 / content / none。 */
  source: "sha256" | "content" | "none";
  /** 人话版的理由。 */
  reason: string;
};

/** 相似度到这个数以上就算「就是这一版」。 */
export const RECOGNIZE_SAME_VERSION = 0.7;
/** 到这个数以上算「同一套标准里的别的版本」。 */
export const RECOGNIZE_SAME_FAMILY = 0.25;
/** 最高分与第二名差不到这个值 → 两版难分，要人来看。 */
export const RECOGNIZE_AMBIGUOUS_GAP = 0.05;
/**
 * 比对时取多少字符。
 *
 * **为什么不是「只看开头」**：只看开头的话，一份**开头像**的文件
 * （同一套标准的封面几乎一样）就会被认成那一版 ——
 * 实测把 A、B 两版各取一半拼起来，比「只看开头」时与 A 的相似度是 **1.00**，
 * 等于把一份混血文件认成了 A 版。
 * 所以这里**跨页采样**（首页 / 第 3 页 / 中段 / 末尾两页），
 * 混血文件在每一段上都对不上，相似度自然掉下来。
 */
export const RECOGNIZE_WINDOW = 20000;

/** 采样 + 取指纹 —— 认版本专用的那一份。 */
function sampleFingerprint(text: string): Set<string> {
  return fingerprint(sampleAcross(String(text ?? "")), RECOGNIZE_WINDOW);
}

/**
 * ① sha256 完全一致 —— 最准也最省的一种认法。
 *
 * @param corpus 语料：`{ A: {sourceSha256}, ... }`
 */
export function recognizeBySha256(
  sha256: string,
  corpus: Record<string, any> | null | undefined,
): VersionGuess {
  const sha = String(sha256 ?? "").toLowerCase();
  if (!sha || !corpus) {
    return { label: null, score: 0, runnerUp: null, source: "none", reason: "没有语料可比对" };
  }
  for (const [ver, doc] of Object.entries(corpus)) {
    const want = String(doc?.sourceSha256 ?? "").toLowerCase();
    if (want && want === sha) {
      return {
        label: ver,
        score: 1,
        runnerUp: null,
        source: "sha256",
        reason: `与语料里的 ${ver} 版**逐字节相同**`,
      };
    }
  }
  return {
    label: null,
    score: 0,
    runnerUp: null,
    source: "none",
    reason: "文件与语料里的任何一份都不逐字节相同",
  };
}

/**
 * ② 内容相似度 —— 同一份标准的另一个副本。
 *
 * @param text 上传文件的正文（MuPDF 文本层）
 * @param refs 参考件：`[{ label, text }]`，text 必须也是**同一种表示**的文本
 */
export function recognizeByReferences(
  text: string,
  refs: Array<{ label: string; text: string }>,
): VersionGuess {
  const mine = sampleFingerprint(text);
  if (!mine.size) {
    return { label: null, score: 0, runnerUp: null, source: "none", reason: "文件里没有可读的文字" };
  }
  if (!refs?.length) {
    return {
      label: null,
      score: 0,
      runnerUp: null,
      source: "none",
      reason: "没有可比对的参考件 —— 这一版的标准认不出来",
    };
  }
  const scored = refs
    .map((r) => ({ label: r.label, score: similarity(mine, sampleFingerprint(r.text)) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];

  if (!best || best.score < RECOGNIZE_SAME_FAMILY) {
    return {
      label: null,
      score: best?.score ?? 0,
      runnerUp: second ? { label: second.label, score: second.score } : null,
      source: "content",
      reason: `与当前这套标准的任何一版都不够像（最高 ${(best?.score ?? 0).toFixed(2)}）—— 这份文件不属于当前这套标准`,
    };
  }
  if (best.score < RECOGNIZE_SAME_VERSION) {
    return {
      label: null,
      score: best.score,
      runnerUp: second ? { label: second.label, score: second.score } : null,
      source: "content",
      reason: `像当前这套标准里的 ${best.label} 版（${best.score.toFixed(2)}），但不是同一份文件 —— 请确认是不是同一版的另一个副本`,
    };
  }
  const gap = second ? best.score - second.score : 1;
  const ambiguous = gap < RECOGNIZE_AMBIGUOUS_GAP;
  // 两版难分时**不认**（label=null）—— 宁可空着，不可错着。
  // 差 0.05 以内就报一个版本，等于把「像」当成「是」；
  // 而这一栏的代价正是「四分钟后拿到一份矩阵错位的报告」。
  return {
    label: ambiguous ? null : best.label,
    score: best.score,
    runnerUp: second ? { label: second.label, score: second.score } : null,
    source: "content",
    reason: ambiguous
      ? `像 ${best.label} 版（${best.score.toFixed(2)}），但与 ${second!.label} 版难分（${second!.score.toFixed(2)}）—— 两版难分时不认，请核对文件来源`
      : `像 ${best.label} 版（相似度 ${best.score.toFixed(2)}）`,
  };
}
