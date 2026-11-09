/**
 * **比较词表** —— 中文与英文的「比较词 → 方向」。
 *
 * ## 为什么单独一个模块
 *
 * `parameterMatrix.ts` 负责**取**口径（`comparatorBefore` ✓），
 * `corroboration.ts` 负责**判状态**（四维表 ✓）——
 * 后者要回答「这个数附近**有没有**比较词」✓（用来区分
 * 「不是限值」与「口径没取到」✓），于是两边都要这份词表 ✓。
 *
 * 放一个独立模块里，两边都 import 它 ✓ → **没有循环依赖** ✓
 * （parameterMatrix → corroboration 这条链已经存在 ✓，
 * 词表再从 parameterMatrix 里拿就成了环 ✗）。
 *
 * ## 「取」与「判」不是一回事
 *
 * | | 问什么 | 判据 |
 * |---|---|---|
 * | `comparatorBefore` | 这个数的口径**是什么** | 精确（方向 + 否定 + 「比较词与取值之间只允许隔单位」✓） |
 * | `hasComparisonWordNear` | 附近**有没有**比较词 | 宽（只看所在句 ✓）—— 用来判「不适用」✓ |
 *
 * 两者的口径差得很远 ✓ —— 精确的那个会因为「比较词离得太远」而**取不到** ✓，
 * 但那不代表「这里没有比较词」✓。所以要两个判据 ✓。
 */
export type Comparator = "<" | "≤" | "≥" | ">" | "=";

export const COMPARATOR_WORDS: Array<[RegExp, Comparator]> = [
  // ① 带否定的大于类 → ≤
  [/(?:不|未)(?:应|得|允许|可|能|准|得|会)?\s*(?:大\s*于|高\s*于|超\s*出|超\s*过)\s*$/, "≤"],
  // ② 带否定的小于类 → ≥
  [/(?:不|未)(?:应|得|允许|可|能|准|得|会)?\s*(?:小\s*于|低\s*于|少\s*于)\s*$/, "≥"],
  // ③ 不带否定的大于类 → >
  [/(?:大\s*于|高\s*于|多\s*于)\s*$/, ">"],
  // ④ 不带否定的小于类 → <
  [/(?:小\s*于|低\s*于|少\s*于)\s*$/, "<"],
  // ⑤ 至多 / 最多 → ≤；至少 / 最少 → ≥
  [/(?:至\s*多|最\s*多)\s*$/, "≤"],
  [/(?:至\s*少|最\s*少)\s*$/, "≥"],
  // ⑥ 等于 → =
  [/(?:等\s*于)\s*$/, "="],
  // ⑥之二 「增至 / 减至」—— **英文那份本来就有** ✓，中文这份漏了 ✗
  //（「may be increased to X」→ 上限 / 「may be reduced to X」→ 下限 ✓）。
  // 「增至」= 增**到**那个数 → 那是上限 ✓；「减至」= 减**到**那个数 → 那是下限 ✓。
  [/(?:可|能|允许|应)?\s*增\s*至\s*$/, "≤"],
  [/(?:可|能|允许|应)?\s*减\s*至\s*$/, "≥"],
  // ⑦ 英文的**等价式**（先判，它们不是「比较词 + 否定」的形状）——
//    否则「less than or equal to」会被 `=` 那条吃掉。
[/(?:less\s+than|equal\s+or\s+less\s+than)\s+or\s+equal\s+to\s*$/, "≤"],
  [/(?:equal\s+or\s+less\s+than)\s*$/, "≤"],
  [/at\s+least\s*$/, "≥"],
  // **「by more than X」是偏差的上限**（deviation … differs by more than 0.15），
  // 不是下限 —— 它必须**先于**裸的「more than」判掉，
  // 否则「偏差不得大于 0.15」会被判成「>」（把法规结论说反）。
  [/\bby\s+(?:more|less)\s+than\s*$/, "≤"],
  // 「可减至 X」→ X 是**下限**；「可增至 X」→ X 是**上限**。
  [/(?:may\s+be\s+)?(?:reduced|shortened|lowered)\s+to\s*$/, "≥"],
  [/(?:may\s+be\s+)?(?:increased|raised|extended)\s+to\s*$/, "≤"],
];

export const ENGLISH_NATURAL: Array<[RegExp, Comparator]> = [
  [/exceed(?:s|ing)?\s*$/, ">"],
  [/above\s*$/, ">"],
  [/(?:greater|larger|higher|further)\s+than\s*$/, ">"],
  [/more\s+than\s*$/, ">"],
  [/(?:below|less\s+than|lower\s+than|fewer\s+than)\s*$/, "<"],
  [/(?:equal\s+to)\s*$/, "="],
];

export const FLIPPED: Record<Comparator, Comparator | null> = {
  "<": "≥",
  ">": "≤",
  "≤": ">",
  "≥": "<",
  "=": null,
};

/**
 * 取值附近**有没有比较词** —— 用来区分「不是限值」与「口径没取到」。
 *
 * 「按 0.1% 的准确度」「单边误差在 50mm 范围内」这类数**本来就没有比较符号** ✓；
 * 把它们标成「口径未判定」是**误导**（读者会以为「337 个限值没判出口径」✗）。
 *
 * 用**同一份词表** ✓（不另写一套 —— 两份词表就会各说各话 ✓）。
 */
export function hasComparisonWordNear(text: string, match: string): boolean {
  const v = String(text ?? "");
  const m = String(match ?? "");
  const at = m ? v.indexOf(m) : -1;
  if (at < 0) return false;
  const ctx = v.slice(Math.max(0, at - 160), at + m.length);
  // **所在句**（不只取值前面那一小段 ✓）——
  // spec 的捕获组有时把比较词**一起**框进去了（「若车宽小于 1300㎜」✓），
  // 那时比较词就在取值的位置上，不在「前面」✓。
  const pieces = ctx.split(/[，,。;；:：]|\. (?=[A-Z])/);
  // **保守**：句子里只要有一个比较词就算「有」✓ ——
  // 判成「不适用」是**危险的方向**（「不适用」= 确定不是限值 ✓，
  // 而不确定的时候我们不确定 ✓ —— 宁可空着，不可错着 ✓）。
  return (
    pieces.some((piece) => UNANCHORED.some((re) => re.test(piece)))
  );
}

/**
 * 词表的**去锚点**版本 —— 判「句子里有没有比较词」用 ✓。
 *
 * 词表里的正则都带 `\s*$`（**贴着取值才算** ✓ 的形状 ✓）——
 * 判「这一句有没有比较词」时那个锚点不适用 ✓，
 * 所以把锚点去掉再用 ✓（**一份词表** ✓ —— 两份就会各说各话 ✓）。
 */
const UNANCHORED: RegExp[] = [...COMPARATOR_WORDS, ...ENGLISH_NATURAL].map(
  ([re]) =>
    new RegExp(
      re.source.replace(/\\s\*\$$/, "").replace(/\$$/, ""),
      re.flags.replace("g", ""),
    ),
);
