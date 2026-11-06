/**
 * **按文件名认版本** —— 判据在声明里（`fileTokens` / `fileExclude`）。
 *
 * ## 为什么要有这个模块
 *
 * 认「这份文件是哪一版」的判据本来有**两份实现**：
 *
 * | 在哪 | 干什么 |
 * |---|---|
 * | `python_service/main.py` | 上传时校验文件名、推断标签 |
 * | `server/reports/htmlRender*.ts` | 渲染时把文件名显示成「GB 4785 草案 V4.3.5」 |
 *
 * 两份都是手写正则，改了一边忘了另一边 —— **漂移的表现是
 * 「封面上的版本名认错了」**，而报告照出、闸门全绿，谁都不会发现。
 *
 * 现在两边都从 `data/standard-pack.json` 的 `fileTokens` / `fileExclude` 取判据：
 * **换标准 = 改一个 JSON**，两份实现一起跟着变。
 *
 * 语义与 Python 那侧一致（`infer_label`）：
 *   · `fileTokens` 里的正则**全部**要命中（不要求顺序）；
 *   · `fileExclude` 里的正则**一个都不能**命中；
 *   · 只命中一版才算数 —— 命中多版说明文件名有歧义，**认不出来**（返回 null）。
 */
import PACK_JSON from "../data/standard-pack.json";
import { versionDoc } from "./versionMeta";

type DeclVersion = {
  key: string;
  fileTokens?: string[];
  fileExclude?: string[];
};

const DECL_VERSIONS: DeclVersion[] =
  (PACK_JSON as unknown as { versions?: DeclVersion[] }).versions ?? [];

/**
 * 从文件名认出是哪一版；认不出来返回 `null`。
 *
 * `null` 不是「没有标准」，是「**这份文件名不足以认出版本**」——
 * 两者在报告里的措辞必须不同（宁可空着，不可错着）。
 */
export function recognizeVersionByFileName(name: string): string | null {
  const hay = String(name ?? "");
  if (!hay.trim()) return null;
  const hits: string[] = [];
  for (const v of DECL_VERSIONS) {
    const tokens = v.fileTokens ?? [];
    if (!tokens.length) continue;
    let ok = true;
    for (const t of tokens) {
      try {
        if (!new RegExp(t, "i").test(hay)) { ok = false; break; }
      } catch {
        ok = false; break; // 声明里写坏的判据 —— 当作不匹配，不猜
      }
    }
    if (!ok) continue;
    for (const x of v.fileExclude ?? []) {
      try {
        if (new RegExp(x, "i").test(hay)) { ok = false; break; }
      } catch {
        /* 坏掉的排除项 —— 当作没排除 */
      }
    }
    if (ok) hits.push(v.key);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 把文件名显示成**文档显示名**。
 *
 * 原来 `htmlRender.ts` 与 `htmlRenderV8.ts` **各写了一份**同样的正则：
 * 认得出 UN R48 就显示「UN R48-09」，认得出 GB 4785 就显示「GB 4785 草案 V4.3.5」…
 * 两份实现迟早漂移，而漂移的表现是「封面上的版本名认错了」——
 * 报告照出、闸门全绿，谁都不会发现。
 *
 * 现在这份实现只有一个，判据在声明里。
 *
 * 认不出来时**不猜**：退回「去掉日期前缀 + 截断」的老办法，
 * 宁可显示原始文件名，也不显示一个可能认错的标准名。
 */
export function cleanDocName(fileName: string): string {
  let n = (fileName ?? "").replace(/\.(pdf|docx?|DOCX?|PDF)$/i, "");
  const hit = recognizeVersionByFileName(n);
  if (hit) return versionDoc(hit);
  // generic fallback: strip date prefixes and internal underscores
  n = n.replace(/^\d{4}-\d{2}-\d{2}[_-]?/, "").replace(/_+/g, " ").trim();
  return n.length > 24 ? n.slice(0, 24) + "…" : n;
}
