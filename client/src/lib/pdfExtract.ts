/**
 * Client-side PDF text extraction using pdfjs-dist (Mozilla's pdf.js).
 *
 * The server can call out to RAG-Anything for proper layout-aware extraction,
 * but the browser can also do a quick & dirty full-text pull so the agent
 * has *something* to reason over even when the dedicated parser is offline.
 */

import type { TextItem } from "pdfjs-dist/types/src/display/api";

export type ExtractedPage = {
  pageNumber: number;
  text: string;
};

export type PdfExtraction = {
  totalPages: number;
  pages: ExtractedPage[];
  /** Full document text concatenated with `\n\n` page separators. */
  fullText: string;
};

let workerConfigured = false;
let cachedWorkerUrl: string | null = null;

async function resolveWorkerUrl(): Promise<string> {
  if (cachedWorkerUrl) return cachedWorkerUrl;
  // Use the package's built worker URL; Vite will resolve it at build time.
  cachedWorkerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  return cachedWorkerUrl;
}

async function ensureWorker(): Promise<typeof import("pdfjs-dist")> {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    const workerSrc = await resolveWorkerUrl();
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    workerConfigured = true;
  }
  return pdfjs;
}

/**
 * Extract plain text from every page of a PDF. The output is intentionally
 * compact: each page becomes a paragraph, joined by blank lines, with the
 * total capped at `maxChars` so we don't blow up the chat context window.
 */
export async function extractPdfText(
  file: File | Blob,
  options: { maxChars?: number } = {},
): Promise<PdfExtraction> {
  const { maxChars = 500_000 } = options;
  const pdfjs = await ensureWorker();
  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages: ExtractedPage[] = [];
  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (("str" in item ? (item as TextItem).str : "") || "").trim())
      .filter(Boolean)
      .join(" ");
    pages.push({ pageNumber: i, text });
    if (fullText.length < maxChars) {
      // 用空格（而非 \n\n）连接各页，避免 markdown 渲染出可见空白段落。
      // 页面标记 [第 X 页] 保留在行首以提供定位锚点。
      fullText += (fullText ? " " : "") + `[第${i}页]` + (text ? ` ${text}` : "");
    }
  }
  if (fullText.length > maxChars) {
    fullText = fullText.slice(0, maxChars) + " …（后续内容已截断）";
  }
  return {
    totalPages: doc.numPages,
    pages,
    fullText: normalizeExtractedText(fullText),
  };
}

/**
 * 规范化 PDF 提取文本。
 *
 * 注意：现在提取时已改用空格连接各页（避免 markdown 渲染空白），
 * 此函数仅作为兜底处理模型输出中的连续空行。
 */
export function normalizeExtractedText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}