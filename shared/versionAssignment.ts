/**
 * **上传件 → 版本标签**的分配 —— 一处实现 ✓，客户端与回归用例都用它 ✓。
 *
 * ## 为什么要有这个模块
 *
 * 同事 issue #1：「上传顺序改变时，法规版本可能错位」✓ ——
 * 先上传「2019 年现行版」时，网页因为它是第一份文件，把它标成 A（新版）✗；
 * 而解析服务按内容/文件名认出它是 B ✗。
 *
 * 原来的分配写在**组件里**（`ReportBuilder.tsx` 两处 ✓）——
 * 两处各写一遍 ✗，而且**没法测** ✗（顺序变了会怎样 ✗？没人知道 ✓）。
 *
 * ## 分配规则
 *
 * ① **按内容认出来的版本优先** ✓ —— 与上传顺序**无关** ✓
 *    （同一个文件认成什么版本，只看它的内容 ✓）。
 * ② 认不出来（`versionGuess.label` 为 null ✓）→ 才落到**按上传顺序**的兜底 ✓
 *    （此时顺序**确实**会影响结果 ✗ —— 所以界面必须让人确认 ✓）。
 * ③ **冲突要报出来**：两份文件认成同一个版本 ✓ → 不静默取第一个 ✗
 *    （那等于**丢一份文件而不报错** ✓），
 *    而是**两份都标成冲突** ✓，交给人确认 ✓（谁才是 A ✓？没依据能猜 ✓）。
 *
 * ③ 是重点 ✓：「宁可空着，不可错着」✓。
 */

/** 一份上传件的识别结果（与 `server/reports/versionRecognize.ts` 的形状对齐 ✓）。 */
export type VersionGuess = {
  label: string | null;
  score: number;
  source: string;
  reason: string;
};

export type UploadDocLike = {
  fileName?: string;
  /** 按内容认出来的版本（null = 认不出 ✓）。 */
  versionGuess?: VersionGuess | null;
  /** **用户确认过的**版本（界面上人工改判的 ✓）—— 优先级最高 ✓。 */
  confirmedLabel?: string | null;
};

export type AssignmentSource = "confirmed" | "content" | "positional";

export type Assignment = {
  /** 最终用哪个版本键 ✓。 */
  label: string;
  /** 这个标签的依据 ✓。 */
  source: AssignmentSource;
  /** 认出来的那个版本（若与最终标签不同 ✓，界面要提示 ✓）。 */
  guessedLabel: string | null;
};

export type AssignmentResult = {
  assignments: Assignment[];
  /**
   * **冲突**：同一个版本键被两份文件占用 ✓。
   * 空数组 = 没有冲突 ✓。
   */
  conflicts: Array<{
    label: string;
    /** 撞在一起的文件名 ✓。 */
    files: string[];
  }>;
  /** **没认出来的文件**（`source === "positional"` ✓）—— 顺序会影响它们 ✓。 */
  unassigned: string[];
};

const FALLBACK_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/**
 * 分配版本标签 —— **纯函数** ✓（同样的输入永远同样的输出 ✓）。
 *
 * @param docs 上传件（**顺序无关** ✓ —— 除了认不出时的兜底 ✓）
 */
export function assignVersionLabels(docs: UploadDocLike[]): AssignmentResult {
  const assignments: Assignment[] = [];
  const conflicts: AssignmentResult["conflicts"] = [];
  const unassigned: string[] = [];
  const taken = new Map<string, Assignment>();

  // ① 用户确认过的先占位 ✓（人工判定的优先级最高 ✓）
  const pending: Array<{ name: string; guess: string | null }> = [];
  for (const doc of docs ?? []) {
    const name = doc.fileName ?? "";
    const confirmed = (doc.confirmedLabel ?? "").trim();
    if (confirmed) {
      const a: Assignment = { label: confirmed, source: "confirmed", guessedLabel: null };
      taken.set(confirmed, a);
      assignments.push(a);
      continue;
    }
    pending.push({ name, guess: doc.versionGuess?.label ?? null });
  }

  // ② 按内容认出来的 ✓（与顺序无关 ✓）
  const guessed: Assignment[] = [];
  for (const { name, guess } of pending) {
    if (!guess) continue;
    const a: Assignment = { label: guess, source: "content", guessedLabel: guess };
    guessed.push(a);
    if (!taken.has(guess)) {
      taken.set(guess, a);
    } else {
      // **冲突**：两份都认成同一版 ✓ —— 不静默取第一个 ✗
      conflicts.push({ label: guess, files: [] });
    }
  }
  // 冲突的文件名补上 ✓
  for (const c of conflicts) {
    c.files = pending.filter((p) => p.guess === c.label).map((p) => p.name);
  }
  // 冲突的那几份**也**进 assignments（标签相同 ✓ —— 界面据此提示 ✓，
  // 服务端会 400 ✓ 当第二道防线 ✓）
  for (const a of guessed) {
    assignments.push(a);
  }

  // ③ 剩下没认出来的 → 按上传顺序兜底 ✓
  const usedGuess = new Set(guessed.map((a) => a.label));
  for (const { name, guess } of pending) {
    if (guess) continue; // 认出来的已经处理过了 ✓
    let label = "";
    for (const cand of FALLBACK_LABELS) {
      if (!taken.has(cand)) {
        label = cand;
        break;
      }
    }
    if (!label) label = `D${assignments.length + 1}`;
    const a: Assignment = { label, source: "positional", guessedLabel: null };
    taken.set(label, a);
    assignments.push(a);
    unassigned.push(name);
  }
  void usedGuess;

  return { assignments, conflicts, unassigned };
}
