/**
 * 版本的**声明式显示名表** —— 从 `data/standard-pack.json` 读。
 *
 * ## 为什么单独成文件
 *
 * 原来它在 `parameterMatrix.ts` 里。而 `parameterMatrix.ts` 会 import
 * 整份 `data/parameter-specs.json`（八百多条正则）。
 * 于是**只想拿一张显示名表**的模块（`typedTables.ts`）也被迫拖上整份 spec ——
 * 打包出来的 `dist/typedTables.js` 有多大，跟它要干什么毫无关系。
 *
 * 现在这张表独立：想用它的人 import 它，不需要碰 spec。
 *
 * ## 为什么数据在 JSON 里而不是在这个 .ts 里
 *
 * 因为**它就是内容**。
 *
 * 以前这张表是 12 行硬编码字面量，换标准时得改代码；
 * 现在它声明在 `data/standard-pack.json` 里 ——
 * **换标准 = 改一个 JSON，代码一行不动。**
 *
 * 这是「内容层」与「机制层」的分界在代码里的落点：
 * 机制（怎么取数、怎么对照、怎么渲染）不认标准；
 * 内容（这几份文件各叫什么）全在声明里。
 *
 * ## 一张表装下「关于这个标准，报告需要知道的一切」
 *
 * | 字段 | 是什么 | 谁在用 |
 * |---|---|---|
 * | `label` | 短标签（表头、章节标题） | 渲染层 |
 * | `desc` | 一句话说明 | 执行摘要 |
 * | `doc` | **文档显示名**（不含页数） | 源文档清单 → **下载文件名** |
 * | `std` | 标准号（概况表那一列） | 第 2 章概况表 |
 * | `status` | 状态（草案/现行/国际法规…） | 第 2 章概况表 |
 *
 * **页数不在这里** —— 页数是**语料的事实**，不是声明：
 * 它从分页文本数出来（见 reportV6 的 `pageCountsOf`）。
 * 写死的页数换一套标准就全错，而且**不报错**：报告照出，只是页数在骗人。
 */
import PACK_JSON from "../../data/standard-pack.json";

/**
 * 版本键。
 *
 * **不要写死成 `"A" | "B" | "C"`** ——
 * 那个类型曾经散落在 `typedTables.ts` 与 `htmlRenderV8.ts` 里，
 * 而版本键本来就该由**语料推导**（`versionsOf`），
 * 探针里跑的是四版（X/Y/Z），写死的类型只是「恰好能编译」。
 */
export type VersionKey = string;

export type VersionMeta = {
  key: VersionKey;
  label: string;
  /** 卡片上的短标签（「草案」「现行」「UN」）—— 也是表头里的那截。 */
  short: string;
  desc: string;
  doc: string;
  std: string;
  status: string;
};

export const VERSION_META: ReadonlyArray<VersionMeta> = (
  (PACK_JSON as unknown as { versions?: VersionMeta[] }).versions ?? []
);

/**
 * 当前语料里**实际有几版**。
 *
 * 渲染层的版本列识别按它走，**不写死 A/B/C** ——
 * 换一套标准（X/Y/Z）或加第四版时，对照表与卡片布局都会跟着变，
 * 而不是把新版本悄悄丢掉。
 *
 * 放在这里而不是渲染器里，是因为**两个模块都要用**：
 * 渲染层（卡片布局、版本列识别）与表格分类器（横向对照表找版本列）。
 * 放在渲染器里的话，表格分类器就只能继续写死 A/B/C。
 */
let ACTIVE_VERSIONS: string[] = VERSION_META.map((m) => m.key);
export function setActiveVersions(v: string[]): void {
  const clean = (v ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (clean.length) ACTIVE_VERSIONS = clean;
}
export function activeVersions(): string[] {
  return [...ACTIVE_VERSIONS];
}

/** Display label for a version key; unknown keys fall back to the key itself. */
export function versionLabel(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.label ?? v;
}

/** 这一版的**文档显示名**（不含页数）—— 源文档清单与下载文件名都从它派生。 */
export function versionDoc(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.doc ?? String(v);
}

/** 这一版的**标准号**（第 2 章概况表那一列）。 */
export function versionStd(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.std ?? String(v);
}

/** 这一版的**状态**（第 2 章概况表那一列）。 */
export function versionStatus(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.status ?? "";
}

/**
 * 把一个「显示名/文档名」归一化成可比较的形态：
 * 去空白、去下划线、去反引号、转大写。
 *
 * 「GB 4785 草案 V4.3.5」→「GB4785草案V4.3.5」
 */
export function normVersionText(s: string): string {
  return (s ?? "")
    .replace(/\*/g, "")
    .replace(/[`_\s　]/g, "")
    .trim()
    .toUpperCase();
}
