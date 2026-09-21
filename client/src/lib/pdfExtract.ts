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

async function ensureWorker(): Promise<typeof import("pdfjs-dist")> {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured) {
    // pdfjs ships its worker as a separate file; on Vite we point at the
    // matching ?url so the bundler emits the asset and the worker URL is valid.
    const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
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
  const { maxChars = 96_000 } = options;
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
      fullText += (fullText ? "\n\n" : "") + `[第 ${i} 页]\n` + text;
    }
  }
  if (fullText.length > maxChars) {
    fullText = fullText.slice(0, maxChars) + "\n\n…（后续内容已截断）";
  }
  return {
    totalPages: doc.numPages,
    pages,
    fullText,
  };
}