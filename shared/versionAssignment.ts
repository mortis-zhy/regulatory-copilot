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
 * ③ **冲突要报出来**：同一个版本键被两份文件占用 ✓ → 不静默取第一个 ✗
 *    （那等于**丢一份文件而不报错** ✓），
 *    而是**两份都标成冲突** ✓，交给人确认 ✓（谁才是 A ✓？没依据能猜 ✓）。
 *
 * ③ 是重点 ✓：「宁可空着，不可错着」✓。
 *
 * ## ⚠ 结果**必须按输入顺序**返回（同事 2026-11-10 复核发现 ✗）
 *
 * 原来这个函数先把「用户确认过的」全部 push 进去，再 push「按内容认出来的」，
 * 最后 push「按顺序兜底的」—— 返回的**数组顺序不是输入顺序** ✗。
 *
 * 而页面是**按下标**贴标签的（`ready.map((d, i) => assignments[i])` ✓）——
 * 于是：
 *
 * > 第一份文件**没认出来**、第二份**认出是 B** 时，
 * > 函数返回 `[B, A]`，页面按上传顺序套用 → **B 标签贴到第一份文件上** ✗✗
 * > （A 是新版、B 是现行版 —— **方向就反了** ✗）。
 *
 * 现在：**下标 i 永远对应第 i 份上传件** ✓ —— 页面按下标取就一定对得上 ✓。
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
  /**
   * **这份是哪一个文件** ✓。
   *
   * 为什么要带上：页面按下标贴标签 ✓，而**下标对不上就是标签贴错文件** ✗
   * （同事 2026-11-10 复核发现 ✗ —— A 是新版、B 是现行版，**方向会反** ✗）。
   * 带上文件名，界面与校验都能**按名字核对** ✓。
   */
  fileName: string;
};

export type AssignmentResult = {
  /**
   * **按输入顺序**的分配结果 ✓ —— `assignments[i]` 对应 `docs[i]` ✓。
   * （页面按下标贴标签 ✓ —— 顺序不对就是**标签贴错文件** ✗。）
   */
  assignments: Assignment[];
  /**
   * **冲突**：同一个版本键被两份文件占用 ✓。
   * 空数组 = 没有冲突 ✓。
   *
   * **用户确认过的标签也要查冲突** ✓ ——
   * 两份都被人确认成 A 时，那**也是**冲突 ✓（同事 2026-11-10 复核发现 ✗：
   * 原来只查「按内容认出来」的重复，人工确认的重复**不报** ✗）。
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
  const list = docs ?? [];
  const conflicts: AssignmentResult["conflicts"] = [];
  const unassigned: string[] = [];
  /** 已经被占用的标签 ✓。 */
  const taken = new Map<string, Assignment>();
  /** 谁占着这个标签 ✓（人工确认与内容识别**一起算** ✓）。 */
  const holders = new Map<string, string[]>();
  /**
   * **按输入顺序**的结果槽 ✓ —— 下标 i 对应 `docs[i]` ✓。
   * （先填坑、最后按顺序输出 ✓ —— 中间怎么算都不影响顺序 ✓。）
   */
  const slots: Array<Assignment | null> = new Array(list.length).fill(null);

  const hold = (label: string, name: string) => {
    const arr = holders.get(label) ?? [];
    if (!arr.includes(name)) arr.push(name);
    holders.set(label, arr);
  };

  // ① 用户确认过的先占位 ✓（人工判定的优先级最高 ✓）
  const pending: Array<{ index: number; name: string; guess: string | null }> = [];
  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    const name = doc.fileName ?? "";
    const confirmed = (doc.confirmedLabel ?? "").trim();
    if (confirmed) {
      const a: Assignment = { label: confirmed, source: "confirmed", guessedLabel: null, fileName: name };
      slots[i] = a;
      if (!taken.has(confirmed)) taken.set(confirmed, a);
      hold(confirmed, name);
    } else {
      pending.push({ index: i, name, guess: doc.versionGuess?.label ?? null });
    }
  }

  // ② 按内容认出来的 ✓（与顺序无关 ✓）
  for (const { index, name, guess } of pending) {
    if (!guess) continue;
    const a: Assignment = { label: guess, source: "content", guessedLabel: guess, fileName: name };
    slots[index] = a;
    if (!taken.has(guess)) taken.set(guess, a);
    hold(guess, name);
  }

  // ③ 剩下没认出来的 → 按上传顺序兜底 ✓
  for (const { index, name } of pending) {
    if (slots[index]) continue; // 已经认出来了 ✓
    let label = "";
    for (const cand of FALLBACK_LABELS) {
      if (!taken.has(cand)) {
        label = cand;
        break;
      }
    }
    if (!label) label = `D${index + 1}`;
    const a: Assignment = { label, source: "positional", guessedLabel: null, fileName: name };
    slots[index] = a;
    taken.set(label, a);
    unassigned.push(name);
  }

  // ④ 冲突：**同一个标签被两份以上文件占用** ✓ ——
  //    人工确认的重复**也算** ✓（同事 2026-11-10 复核发现 ✗）。
  for (const [label, files] of holders) {
    if (files.length > 1) conflicts.push({ label, files });
  }

  return { assignments: slots.map((a) => a as Assignment), conflicts, unassigned };
}
