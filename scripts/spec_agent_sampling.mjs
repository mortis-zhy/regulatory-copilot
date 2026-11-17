/**
 * 回归的**取样规则** —— 单独成模块，好让用例直接驱动它（**不调模型** ✓）。
 *
 * ## 为什么要有这一段
 *
 * 原来的规则是「每个装置**只取一条**」✗ —— 候选池明明够 ✓（实测 737 条 ✓），
 * 却在**装置数不够**时**永远到不了**要求的条数 ✗（50 个装置 ⇒ 只挑到 50 条 ✗），
 * 而日志还写「池子不够」✗ —— **说反了** ✗：池子够 ✓，是**规则**卡住的 ✗。
 *
 * 于是「要求 120 条」这个数**从来没被真测到过** ✗ ——
 * 而报告里写着「要求 120」✗ ⇒ 读的人以为测了 120 ✗。
 *
 * ## 现在的规则
 *
 * ① **第一轮**：每个装置取一条 ✓（多样性 ✓ —— 别都挑同一个灯 ✓）；
 * ② **第二轮**：没凑够就补 ✓（同一装置可以再取 ✓）；
 * ③ 同一个**槽位**（参数 + 版本）不重复 ✓；
 * ④ 指定了 `ids` ⇒ 只取这几条 ✓（不看条数上限 ✓）。
 *
 * @param {Array<{spec:{id:string}, version:string, device:string}>} pool
 * @param {number} sampleSize
 * @param {string[]} ids
 */
export function pickSample(pool, sampleSize, ids = []) {
  // **总共序** ✓ —— 同一个参数有多个版本 ⇒ 只按 `spec.id` 排序时**并列** ✗，
  // 而并列项的顺序取决于**池子进来的顺序** ✗ ⇒ 同一个池子换个顺序取样，
  // 结果就**不一样** ✗（用例 `_test_spec_sampling.mjs` 抓到的 ✓）。
  // 回归要**可复现** ✓ ⇒ 版本也参与排序 ✓。
  const sorted = [...pool].sort(
    (a, b) =>
      a.spec.id.localeCompare(b.spec.id) || String(a.version).localeCompare(String(b.version)),
  );
  const slotKey = (p) => `${p.spec.id}::${p.version}`;

  // ④ 指定了 id ⇒ 只取这几条（**不受 sampleSize 限制** ✓）
  if (ids.length) {
    return sorted.filter((p) => ids.includes(p.spec.id));
  }

  const picked = [];
  const taken = new Set();
  const usedDevices = new Set();

  // ① 每个装置一条
  for (const p of sorted) {
    if (picked.length >= sampleSize) break;
    if (usedDevices.has(p.device)) continue;
    usedDevices.add(p.device);
    taken.add(slotKey(p));
    picked.push(p);
  }
  // ② 补齐（同一装置可以再取 ✓，但同一槽位不重复 ✓）
  for (const p of sorted) {
    if (picked.length >= sampleSize) break;
    const k = slotKey(p);
    if (taken.has(k)) continue;
    taken.add(k);
    picked.push(p);
  }
  return picked;
}
