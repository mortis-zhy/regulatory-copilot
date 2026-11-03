/**
 * 下载文件名：**从报告的源文档清单派生**，不写死标准名。
 *
 * ## 为什么
 *
 * 原来两处都写死：
 *   `a.download = "GB 4785 多版本横向对比研究报告.pdf"`
 *   `link.download = "GB4785_多版本横向对比研究报告.pdf"`
 *
 * 换一套新标准时，网站下载下来的 PDF **名字还写着 GB 4785** ——
 * 文件名是交付件的一部分（收件人先看名字），而它会骗人。
 *
 * 这正是本项目反复治的那一类：**数字/名字会过期，而过期不会报错。**
 *
 * ## 为什么放在服务端
 *
 * 两条下载路径里，只有一条（`/api/agent/report/render`）客户端手里有报告对象；
 * 另一条（`/api/agent/report/pdf`）是**服务端**读 `reports/last-report.json`
 * 自己渲染的，客户端什么都不知道。
 * 所以名字必须由**服务端**给 —— 客户端从响应头里取，
 * **一份实现，两条路都准**。
 *
 * ## 派生规则
 *
 *   源文档清单 → 去掉页数括注 → 去掉空白与非法字符 → 用 `-` 连起来
 *   → `_多版本横向对比研究报告.<ext>`
 *
 * 例（GB 4785 三版）：
 *   "GB 4785 草案 V4.3.5（103 页）" / "GB 4785-2019（81 页）" / "UN R48-09（147 页）"
 *   → "GB4785草案V4.3.5-GB4785-2019-UNR48-09_多版本横向对比研究报告.pdf"
 *
 * 拿不到源文档清单时退回一个**不带标准名**的通用名 ——
 * 宁可少写，不可写错。
 *
 * ## 草稿必须自带标记
 *
 * 「快速草稿（未经核验）」走的是同一个渲染器、同一套版式，
 * 派生出来的文件名与交付件**一模一样** ——
 * 于是同事把草稿发给客户，文件名上没有任何提示。
 *
 * 那是这个项目最贵的一类错：**安静地给出一份未经核验的东西。**
 * 所以：报告带 `generator` 且不是 `mineru` 的，文件名里必须带标记。
 * **没有 generator 标记的也算草稿** —— 证明不了它来自已核验管线，
 * 就不能让它冒充交付件（与 `/report/pdf` 的护栏同一口径）。
 */

/** 文件名里不能出现的字符（Windows 最严的那一套）。 */
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * 去掉「（103 页）」「(81 pages)」这类页数括注。
 *
 * **不能用 `\b`**：JS 的 `\w` 只含 [A-Za-z0-9_]，「页」不是词字符，
 * 于是「（103 页）」里的 `\b页\b` 两边都不是词字符 → 没有边界 → 匹配不上。
 * 第一版就栽在这儿：派生出来的名字里还留着「（103 页）」。
 */
export function stripPages(s: string): string {
  return String(s ?? "")
    .replace(/[（(][^（）()]{0,24}?(?:页|pages?)[^（）()]{0,12}[)）]/gi, "")
    .trim();
}

/** 去掉空白（中文文件名里空格只会碍事）。 */
function tight(s: string): string {
  return s.replace(/\s+/g, "");
}

export type FileNameSource = {
  sourceDocuments?: Array<{ label?: string; name?: string }>;
  outline?: { title?: string };
  /** 产出这条报告的管线：mineru = 已回源复核；其余 = 草稿。 */
  generator?: string;
};

/** 已核验交付件的 generator 值。 */
export const VERIFIED_GENERATOR = "mineru";

/** 草稿文件名上的标记（中文）。 */
export const DRAFT_MARKER = "（快速草稿·未经回源复核）";

/** 草稿文件名上的标记（ASCII 兜底名用）。 */
export const DRAFT_MARKER_ASCII = "-draft-unverified";

/**
 * 这份报告是不是「未经回源复核的草稿」。
 *
 * **没有 generator 标记的也算草稿** —— 证明不了它来自已核验管线，
 * 就不能让它冒充交付件。与 `/report/pdf` 的护栏同一口径：
 * 那边是 `prefer !== actual → 409`，这边是「不是 mineru → 加标记」。
 */
export function isUnverifiedDraft(report: FileNameSource | null | undefined): boolean {
  const g = typeof report?.generator === "string" ? report.generator.trim() : "";
  return g !== VERIFIED_GENERATOR;
}

/** 报告的源文档清单 → 文件名主干（不含扩展名）。 */
export function reportFileStem(report: FileNameSource | null | undefined): string {
  const base = "多版本横向对比研究报告";
  const draft = isUnverifiedDraft(report) ? DRAFT_MARKER : "";
  const docs = (report?.sourceDocuments ?? [])
    .map((d) => stripPages(String(d?.name ?? "")).trim())
    .filter(Boolean);
  if (!docs.length) return `${base}${draft}`;
  const joined = docs.map(tight).join("-");
  // 太长就退到「第一份 + 份数」—— 文件名过长在很多系统上会被截断。
  const stem = joined.length > 72 ? `${tight(docs[0])}等${docs.length}份` : joined;
  return `${stem}_${base}${draft}`;
}

/** UTF-8 文件名（给客户端 `a.download` 用）。 */
export function reportFileName(report: FileNameSource | null | undefined, ext: "pdf" | "doc"): string {
  return `${reportFileStem(report)}.${ext}`;
}

/**
 * Content-Disposition 的两个文件名：
 *   filename="..."        ASCII 兜底（旧客户端）
 *   filename*=UTF-8''...  UTF-8 正式名（RFC 6266，浏览器优先用它）
 */
export function contentDisposition(report: FileNameSource | null | undefined, ext: "pdf" | "doc"): string {
  const utf8 = reportFileName(report, ext);
  const ascii = `${asciiStem(report) || "multiversion-comparison-report"}.${ext}`;
  const encoded = encodeURIComponent(utf8);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * ASCII 兜底名：把每个源文档名里的非 ASCII 部分去掉，
 * 剩下的用 `-` 连起来（'GB 4785 草案 V4.3.5（103 页）' → 'GB4785-V4.3.5'）。
 */
export function asciiStem(report: FileNameSource | null | undefined): string {
  const draft = isUnverifiedDraft(report) ? DRAFT_MARKER_ASCII : "";
  const docs = (report?.sourceDocuments ?? [])
    .map((d) => stripPages(String(d?.name ?? "")).trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/[^\x20-\x7e]+/g, " ")
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);
  if (!docs.length) return draft ? `multiversion-comparison-report${draft}` : "";
  return `${docs.join("-")}_multiversion-comparison-report${draft}`;
}

/**
 * 自定义头里的文件名：**百分号编码**。
 *
 * Node 的 HTTP 层**拒绝非 ASCII 的 header 值** ——
 * 直接塞 UTF-8 会得到
 * `Invalid character in header content ["X-Report-Filename"]`（500）。
 * 客户端那边 decodeURIComponent 一次就还原。
 */
export function reportFileNameHeader(report: FileNameSource | null | undefined, ext: "pdf" | "doc"): string {
  return encodeURIComponent(reportFileName(report, ext));
}
