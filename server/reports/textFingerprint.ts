/**
 * 文本指纹 —— 「这两段文字是不是同一份文档」。
 *
 * ## 为什么用字符二元组
 *
 * 最早用**页数**认版本，那是个陷阱：两份文档页数相同时，
 * `byCount.set(pages, file)` 会**悄悄覆盖**，两份版本于是指向**同一份文件** ——
 * 一条**错值**的路径，而且**不报错**。
 *
 * 改成比**开头文字**：开头像的，就是同一份文档，不管它多长。
 *
 * ## 为什么 Dice 相似度而不是精确匹配
 *
 * PDF 的文本层每次抽取都可能差几个字符（连字符、页眉页脚）。
 * 精确匹配会因为一个字对不上就全盘失败。
 * Dice 系数（字符二元组的重合度）对这种噪声不敏感。
 */

/** 文本指纹：字符二元组的集合。 */
export function fingerprint(text: string, take = 600): Set<string> {
  const clean = String(text ?? "")
    .replace(/\[第\d+页\]/g, "")
    .replace(/<[^>]*>|\$[^$]*\$/g, "")
    .replace(/[^0-9A-Za-z一-鿿]/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= Math.min(clean.length, take); i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

/** Dice 系数 —— 1 表示开头文字完全一样。 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * 从一整份文本里**跨页采样**若干段，拼成一段「代表文本」。
 *
 * 为什么不能只看开头：GB 4785 的草案与它的 2019 现行版**封面几乎一样**
 * （「GB 4785 … 汽车及挂车外部照明…」），只看开头两者得分 0.69，
 * 分不出谁是谁。真正区分它们的是第 3 页与末尾。
 */
export function sampleAcross(text: string, pagesHint = 0): string {
  const t = String(text ?? "");
  if (!t) return "";
  // 有页标记就按页切；没有就按长度均分成 5 段。
  const chunks = t.includes("[第")
    ? t.split(/\[第\d+页\]/).filter((c) => c.trim().length > 0)
    : null;
  if (chunks && chunks.length >= 3) {
    const pick = [0, 2, Math.floor(chunks.length / 3), chunks.length - 2, chunks.length - 1]
      .filter((i) => i >= 0 && i < chunks.length);
    return pick.map((i) => chunks[i]).join("");
  }
  const n = Math.max(1, Math.floor(t.length / 5));
  const pick = [0, 2 * n, 3 * n, 4 * n, t.length - n].filter((i) => i >= 0 && i < t.length);
  return pick.map((i) => t.slice(i, i + n)).join("");
}
