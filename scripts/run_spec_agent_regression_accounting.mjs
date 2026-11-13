/**
 * 回归脚本的**记账规矩** —— 「没跑成」不许被记成「没编造」。
 *
 * ## 为什么要单独成文件
 *
 * `scripts/run_spec_agent_regression.mjs` 一上来就**调模型** ✗ ——
 * 所以用例没法直接 import 它 ✗（那要花钱 ✗，而且额度可能已经用完 ✗）。
 *
 * 而**判定逻辑**（什么算「没跑成」、写盘时怎么算）必须是**一份** ✗ ——
 * 抄一份到用例里 = 两份实现会漂移 ✗ ⇒ 用例测的东西与脚本跑的东西可能不是一回事 ✗。
 *
 * 所以：判定逻辑住在这里 ✓，脚本 import 它 ✓，用例也 import 它 ✓。
 *
 * ## 判的是什么
 *
 * **「没跑成」≠「通过」** ✗ —— 同事 2026-11-10 复核抓到过这一类，
 * 这里藏得更深 ✗：它在**记账**里（`reports/spec-agent-baseline.json`），
 * 不在闸门里 ✗ —— 闸门红了会有人看见 ✗，记账里的假数**没人看见** ✗。
 *
 * 实测（2026-11-13）：跑 120 条那轮撞上 **HTTP 402**（Token Plan 用量上限），
 * 空槽（编造率）那 40 条里 **28 条根本没跑成** ✗ —— 而脚本写成 `fabricated: 0` ✗。
 * 上一轮**真的**有 4 条编造 ✗ ⇒ 文件里的数从「4」变成「0」✗
 * ⇒ 读的人以为「**编造问题解决了**」✗，真相是「**模型没答**」✗。
 */

/**
 * 这一批行是不是**全盘同一个错**。
 *
 * 全是同一个错 ⇒ 不是「质量差」，是**一次都没跑成** ✗
 * （余额不足 / 模型不可用 / 网络断了）——
 * 那不是「泛化率 0」，也不能写成「没编造」✗。
 *
 * @param {Array<{error?: string|null}>} rows
 * @returns {string|null} 那个错（截断到 120 字），或 null（不是全盘同一个错）
 */
export function commonFailure(rows) {
  const errs = rows
    .map((r) => String(r.error ?? "").trim())
    .filter(Boolean)
    .map((e) => e.slice(0, 120));
  if (!errs.length) return null;
  if (errs.length < rows.length) return null; // 不是全盘同一个错 → 是质量问题
  const first = errs[0];
  if (!errs.every((e) => e === first)) return null;
  return first;
}

/**
 * 空槽（编造率）那半边**写盘时该写什么**。
 *
 * 两条路：
 *   · **跑成了** ⇒ 写实的数 ✓（含 `ran` / `notRun` ✓ —— 让读的人知道
 *     `fabricated` 只覆盖跑成的那几条 ✗）；
 *   · **没跑成** ⇒ **保留上一次的真结果 + 标注** ✓ ——
 *     绝不用这一轮的「0 条编造」把它盖掉 ✗
 *     （那会让「4 条编造」凭空变成「0 条编造」✗）。
 *
 * @param {{absentRows: Array<any>, absentDidNotRun: string|null, previous: any|null}} args
 */
export function buildAbsentBlock({ absentRows, absentDidNotRun, previous }) {
  const notRun = absentRows.filter((r) => r.kind === "not-run").length;
  if (absentDidNotRun) {
    if (previous) {
      return {
        ...previous,
        _carriedOver:
          `这一轮的编造率**没跑成**（${String(absentDidNotRun).slice(0, 120)}）—— ` +
          "这里保留的是**上一次跑成**的结果 ✓，别当成这一轮的数 ✓",
      };
    }
    return {
      sampleSize: absentRows.length,
      ran: 0,
      notRun: absentRows.length,
      saidAbsent: 0,
      fabricated: 0,
      wrongQuantity: 0,
      hallucinated: 0,
      _notRun:
        `这一轮没跑成（${String(absentDidNotRun).slice(0, 120)}）—— ` +
        "**没有数据**，不是「0 条编造」✗",
      rows: [],
    };
  }
  return {
    sampleSize: absentRows.length,
    // **跑成几条 / 没跑成几条** ✓ ——
    // 只有这一个数能让读的人知道 `fabricated: 0` 覆盖的是哪一批 ✓
    ran: absentRows.length - notRun,
    notRun,
    saidAbsent: absentRows.filter((r) => r.saidAbsent).length,
    fabricated: absentRows.filter((r) => r.fabricated).length,
    // **误配量值与凭空生成也要单列** ✓ ——
    // 合在 `fabricated` 里的话，「编造」这个词就同时指两种不同的病 ✗
    wrongQuantity: absentRows.filter((r) => r.kind === "wrong-quantity").length,
    hallucinated: absentRows.filter((r) => r.kind === "hallucinated").length,
    rows: absentRows,
  };
}
