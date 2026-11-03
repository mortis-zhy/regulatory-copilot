/**
 * 版本的**声明式显示名表** —— 这个项目里唯一一处「关于这个标准，报告需要知道的一切」。
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
export type VersionKey = "A" | "B" | "C";

export type VersionMeta = {
  key: VersionKey;
  label: string;
  desc: string;
  doc: string;
  std: string;
  status: string;
};

export const VERSION_META: ReadonlyArray<VersionMeta> = [
  {
    key: "A",
    label: "A 草案",
    desc: "GB 4785 草案 V4.3.5（新版）",
    doc: "GB 4785 草案 V4.3.5",
    std: "GB 4785—XXXX",
    status: "草案 V4.3.5（代替 GB 4785-2019）",
  },
  {
    key: "B",
    label: "B 现行",
    desc: "GB 4785-2019（现行）",
    doc: "GB 4785-2019",
    std: "GB 4785—2019",
    status: "现行（代替 GB 4785—2007，2020-07-01 实施）",
  },
  {
    key: "C",
    label: "C UN R48-09",
    desc: "UN R48-09（国际参照，仅作对照不做变化判定）",
    doc: "UN R48-09",
    std: "UN R48-09 + Suppl.1",
    status: "国际法规（2025-09-26 生效，作参照）",
  },
];

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
