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
 * 一轮跑下来，**有多少条真的跑了**。
 *
 * ## 为什么要有「系统性失败」这个判据
 *
 * 原来的判据是「**全部**槽位都失败、而且错的是**同一件事**」✗ ⇒ 才算「没跑成」✓。
 * 实测（2026-11-13）打脸了 ✗：空槽那 40 条里 **39 条**撞上 402 ✗，
 * 但**错法不完全一样** ✗（截断位置不同 ⇒ 字符串不同 ✗）⇒ 判据不触发 ✗
 * ⇒ 这一轮照样把「4 条编造」盖成了「0 条编造」✗ ✗。
 *
 * 判据应该是**比例**而不是**字符串相等** ✓：
 * **一半以上没跑成 ⇒ 这一轮不能代表能力** ✓
 * （样本里 39/40 挂了 ✗，剩下那 1 条能说明什么 ✗）。
 *
 * ## 为什么「没跑成」不能写成 0
 *
 * 「没跑成」被记成「**没编造**」⇒ 读的人以为「编造问题解决了」✗
 * —— 其实只是**模型没答** ✗。**宁可空着，不可错着** ✓。
 */
export function phaseOutcome(total, notRun, reason) {
  const n = Math.max(0, Number(total) || 0);
  const u = Math.max(0, Number(notRun) || 0);
  return {
    ran: n - u,
    notRun: u,
    // **一半以上没跑成** ⇒ 这一轮**不能代表能力** ✓ ⇒ 不许覆盖上次的真结果 ✓
    systemic: u > 0 && u >= n * 0.5,
    reason: reason ?? null,
  };
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
  const outcome = phaseOutcome(absentRows.length, notRun, absentDidNotRun);
  if (outcome.systemic) {
    if (previous) {
      return {
        ...previous,
        // **这一轮尝试跑了多少** ✓ —— 读的人要能看见
        // 「上面那些数是**上一轮**的，这一轮只跑成了 N 条」✓
        _attemptRan: outcome.ran,
        _attemptNotRun: outcome.notRun,
        _carriedOver:
          `这一轮的编造率**没跑成**（${String(absentDidNotRun ?? "大部分槽位失败").slice(0, 120)}；` +
          `跑成 ${outcome.ran} / ${absentRows.length}）—— ` +
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
        `这一轮没跑成（${String(absentDidNotRun ?? "大部分槽位失败").slice(0, 120)}）—— ` +
        "**没有数据**，不是「0 条编造」✗",
      rows: [],
    };
  }
  return {
    sampleSize: absentRows.length,
    // **跑成几条 / 没跑成几条** ✓ ——
    // 只有这一个数能让读的人知道 `fabricated: 0` 覆盖的是哪一批 ✓
    ran: outcome.ran,
    notRun: outcome.notRun,
    saidAbsent: absentRows.filter((r) => r.saidAbsent).length,
    fabricated: absentRows.filter((r) => r.fabricated).length,
    // **误配量值与凭空生成也要单列** ✓ ——
    // 合在 `fabricated` 里的话，「编造」这个词就同时指两种不同的病 ✗
    wrongQuantity: absentRows.filter((r) => r.kind === "wrong-quantity").length,
    hallucinated: absentRows.filter((r) => r.kind === "hallucinated").length,
    rows: absentRows,
  };
}
