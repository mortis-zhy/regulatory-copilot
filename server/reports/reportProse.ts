/**
 * **报告正文散文** —— 从 `data/report-prose.json` 读。
 *
 * 这些话换一套标准时**必须重写**（讲的是这一套标准怎么组织条款），
 * 而它们原来写在代码里 —— **改代码比改数据危险**：
 * 改坏了照样跑得出来，只是**说错话**。
 *
 * 搬进数据文件之后：换标准时**只改那个文件**（agent 写、人核事实），
 * 而不是翻代码。闸门核它们的**事实**（标准号、条款号必须真在语料里）。
 */
import PROSE_DATA from "../../data/report-prose.json";

/** 散文 id → 文字。 */
export const PROSE: Record<string, string> = Object.fromEntries(
  ((PROSE_DATA as any).rows ?? []).map((r: any) => [r.id, r.text]),
);

/**
 * 取一段散文 —— **取不到就抛错**。
 *
 * 不抛错的话，取不到会变成 `undefined` 拼进报告里，
 * 报告照出，只是**少了一句话** —— 读者以为那一句本来就不该有。
 */
export function prose(id: string): string {
  const t = PROSE[id];
  if (t === undefined) {
    throw new Error(
      `报告散文「${id}」不在 data/report-prose.json 里 —— ` +
        `散文缺了会变成「少一句话」，而读者看不出来。`,
    );
  }
  return t;
}
