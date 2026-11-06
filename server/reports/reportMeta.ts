/**
 * 报告**标题层**的声明与组装。
 *
 * ## 为什么要有这一层
 *
 * 封面标题、章节标题、附录标题里**点了标准的名**：「GB 4785」「UN R48-09 §6」。
 * 以前这些是 reportV6.ts 里的字面量 —— 它们**不跟着语料走**：
 * 换一套标准，机制照样跑得通，闸门照样全绿，
 * 而**封面会一本正经地讲错标准**。
 *
 * 这正是「宁可空着，不可错着」的反面：
 * 不是空着，是**错着**，而且读者看不出来。
 *
 * ## 怎么组装
 *
 * `data/standard-pack.json` 声明**模板**与**标准特有的那几个词**；
 * 模板里的 `{…}` 占位符由**语料推导**的版本清单填充：
 *
 * | 占位符 | 含义 | 现在填什么 |
 * |---|---|---|
 * | `{standardFamily}` | 标准族名（声明） | GB 4785 |
 * | `{standardFamilyShort}` | 标准族短名（声明） | GB4785 |
 * | `{versionLabels}` | 各版本的展示名（`VERSION_META`） | A 草案 / B 现行 / C UN R48-09 |
 * | `{keyList}` | 版本键，斜杠连 | A/B/C |
 * | `{keyListPipe}` | 版本键，竖线连 | A\|B\|C |
 * | `{pairSlash}` / `{pairVs}` | 前两个版本 | A/B / A vs B |
 * | `{countWord}` / `{countZhou}` | 版本数的中文说法 | 三版本 / 三版 |
 * | `{lastKey}` / `{lastDoc}` | 最后一个版本 | C / UN R48-09 |
 * | `{clauseOfLast}` | 末版「灯具安装」那一章的条款号（声明） | §6 |
 *
 * ## 为什么要拆成两个模块
 *
 * 这个文件**不 import parameterMatrix** —— 参数矩阵会把整份 spec
 * （几十万行）打进包里，而这里只需要两个查名字的函数。
 * 所以「版本 → 展示名 / 文档名」由调用方以函数参数传进来：
 * 报告层传 `versionLabel`/`versionDoc`，闸门可以传自己造的假版本名来驱动。
 */
import META_JSON from "../../data/standard-pack.json";

export type ReportMetaDecl = {
  standardFamily: string;
  standardFamilyShort: string;
  clausesOfLastVersion: string;
  /** 各版本的显示名表 —— 见 server/reports/versionMeta.ts。 */
  versions: Array<{
    key: string;
    label: string;
    short: string;
    desc: string;
    doc: string;
    std: string;
    status: string;
    rev: string;
  }>;
  titleTemplate: string;
  chapterTitles: Record<string, string>;
  chapter11Sections: string[];
  appendixTitles: Record<string, string>;
};

export const REPORT_META: ReportMetaDecl = META_JSON as unknown as ReportMetaDecl;

/** 组装标题时要填的槽位。 */
export type TitleSlots = {
  /** 语料里实际存在的版本键，按显示顺序。 */
  keys: string[];
  /** 每个版本的展示名（「A 草案」）。 */
  labels: string[];
  /** 每个版本的文档名（「UN R48-09」）。 */
  docs: string[];
};

const CN_DIGITS = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九"];

/** 版本数的中文说法：「3」→ 「三版本」。 */
export function countWord(n: number): string {
  if (n >= 1 && n <= CN_DIGITS.length) return `${CN_DIGITS[n]}版本`;
  return `${n}版本`;
}

/** 版本数的另一种说法：「3」→ 「三版」（量词「版」而不是「版本」）。 */
export function countZhou(n: number): string {
  if (n >= 1 && n <= CN_DIGITS.length) return `${CN_DIGITS[n]}版`;
  return `${n}版`;
}

/** 把占位符填上。未知占位符原样留着 —— 留着才看得出模板写错了。 */
function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(slots, name) ? slots[name] : whole,
  );
}

/** 由版本清单算出全部槽位。 */
export function titleSlots(keys: string[], labels: string[], docs: string[]): TitleSlots {
  return { keys, labels, docs };
}

/** 槽位 → 字符串字典（占位符名 → 值）。 */
export function slotValues(s: TitleSlots): Record<string, string> {
  const n = s.keys.length;
  const pair = s.keys.slice(0, 2);
  return {
    standardFamily: REPORT_META.standardFamily,
    standardFamilyShort: REPORT_META.standardFamilyShort,
    clauseOfLast: REPORT_META.clausesOfLastVersion,
    versionLabels: s.labels.join(" / "),
    keyList: s.keys.join("/"),
    keyListPipe: s.keys.join("|"),
    pairSlash: pair.join("/"),
    pairVs: pair.join(" vs "),
    countWord: countWord(n),
    countZhou: countZhou(n),
    lastKey: s.keys[s.keys.length - 1] ?? "",
    lastDoc: s.docs[s.docs.length - 1] ?? "",
  };
}

/** 报告封面标题。 */
export function composeTitle(s: TitleSlots): string {
  return fill(REPORT_META.titleTemplate, slotValues(s));
}

/** 章节标题（按章节 id）。没声明的章节 id 返回空串。 */
export function composeChapterTitle(id: number | string, s: TitleSlots): string {
  const t = REPORT_META.chapterTitles[String(id)];
  return t ? fill(t, slotValues(s)) : "";
}

/** 第 11 章的目录项。 */
export function composeChapter11Sections(s: TitleSlots): string[] {
  return REPORT_META.chapter11Sections.map((t) => fill(t, slotValues(s)));
}

/** 附录标题（按附录 id）。没声明的 id 返回空串。 */
export function composeAppendixTitle(id: string, s: TitleSlots): string {
  const t = REPORT_META.appendixTitles[id];
  return t ? fill(t, slotValues(s)) : "";
}

/** 全部附录标题（按声明顺序）。 */
export function composeAppendixTitles(s: TitleSlots): { id: string; title: string }[] {
  return Object.keys(REPORT_META.appendixTitles).map((id) => ({
    id,
    title: composeAppendixTitle(id, s),
  }));
}
