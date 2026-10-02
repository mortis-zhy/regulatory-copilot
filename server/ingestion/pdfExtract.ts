/**
 * Server-side PDF extraction using MuPDF.js (WASM).
 *
 * Why the table layer matters: regulatory PDFs like GB 4785 carry most of
 * their quantitative data in layout tables (光色 / 色度坐标 / 安装高度 /
 * 试验项目 / 触发条件 / 角度限值). Pure text extraction flattens those
 * tables into linear prose, which makes diff engines miss data indicator
 * changes (DRL 400→500 cd, ESS 4→5 Hz, LED 寿命 2000→3000 h etc).
 *
 * PyMuPDF's `page.find_tables()` recovers the row × column structure with
 * high fidelity on standards-grade PDFs (it doesn't need ML — it uses
 * vector geometry + heuristics). We surface those tables as a separate
 * `tables` array on the parse result, AND inline-render them into the
 * `fullText` field as Markdown tables so the LLM extractor can see them
 * naturally.
 */

export type ServerParsedPage = {
  pageNumber: number;
  text: string;
  /** Tables detected on this page, in document order. */
  tables: ServerParsedTable[];
};

export type ServerParsedTable = {
  /** Per-page index (0-based). */
  index: number;
  /** First non-empty cell as a best-effort title; "" if no caption. */
  title: string;
  /** Rows × cols matrix; empty cells are "". */
  rows: string[][];
};

export type ServerParseResult = {
  totalPages: number;
  fullText: string;
  pages: ServerParsedPage[];
};

/** Collapse runs of blank/whitespace-only lines and trim each page's text. */
function compactPageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Render a row × cols matrix as a Markdown table block. */
function tableToMarkdown(t: ServerParsedTable): string {
  if (!t.rows.length || !t.rows[0]?.length) return "";
  // Find widest row (sometimes tables have ragged columns).
  const cols = Math.max(...t.rows.map((r) => r.length));
  const padded = t.rows.map((r) => {
    while (r.length < cols) r.push("");
    return r;
  });
  const header = padded[0];
  const sep = Array.from({ length: cols }, () => "---");
  const body = padded.slice(1);
  const fmt = (row: string[]) =>
    "| " +
    row
      .map((c) =>
        (c || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240),
      )
      .join(" | ") +
    " |";
  const out = [fmt(header), fmt(sep), ...body.map(fmt)];
  if (t.title) out.unshift(`**${t.title}**`);
  return out.join("\n");
}

/**
 * Extract every layout table on the page. Returns the parsed table objects
 * (NOT joined with body text — caller decides whether to inline). Empty
 * strings are preserved as empty cells so the matrix geometry stays intact.
 */
function detectTables(page: any): ServerParsedTable[] {
  const out: ServerParsedTable[] = [];
  // PyMuPDF exposes page.find_tables() which returns a Tables object.
  // Each `tables[i].extract()` yields a 2D array of cell strings.
  let finder: any;
  try {
    finder = page.findTables();
  } catch {
    return out;
  }
  if (!finder || !finder.tables) return out;
  for (let i = 0; i < finder.tables.length; i++) {
    const t = finder.tables[i];
    let rows: string[][] = [];
    try {
      rows = (t.extract?.() ?? []) as string[][];
    } catch {
      rows = [];
    }
    if (!rows.length) continue;
    // Normalise: coerce each cell to a trimmed string; drop purely-empty
    // rows except the first (header).
    const cleaned: string[][] = [];
    rows.forEach((r, ri) => {
      const cells = (r || []).map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim()));
      const allEmpty = cells.every((c) => !c);
      if (!allEmpty || ri === 0) cleaned.push(cells);
    });
    if (!cleaned.length) continue;
    // Heuristic title = first non-empty cell in the FIRST row that has
    // a non-numeric short string (≤ 30 chars). If none, leave title "".
    let title = "";
    for (const c of cleaned[0] || []) {
      if (c && c.length <= 30 && !/^[\d.\-+]+$/.test(c)) {
        title = c;
        break;
      }
    }
    out.push({ index: i, title, rows: cleaned });
  }
  return out;
}

export async function extractPdfTextServer(bytes: Buffer | Uint8Array): Promise<ServerParseResult> {
  try {
    const mupdf = await import("mupdf");
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const doc = mupdf.Document.openDocument(buf, "application/pdf");
    const totalPages = doc.countPages();
    const pages: ServerParsedPage[] = [];
    const parts: string[] = [];

    for (let i = 0; i < totalPages; i++) {
      const page = doc.loadPage(i);
      const raw = page.toStructuredText("preserve-whitespace").asText();
      const pageText = compactPageText(raw);
      const tables = detectTables(page);
      pages.push({ pageNumber: i + 1, text: pageText, tables });

      // Inline the tables into fullText as Markdown, placed AFTER the
      // body text. This way the structuredExtract LLM sees them
      // naturally in document order.
      const tableMd = tables.map(tableToMarkdown).filter(Boolean).join("\n\n");
      const pageBlock = pageText
        ? `[第${i + 1}页]\n${pageText}${tableMd ? "\n\n" + tableMd : ""}`
        : "";
      if (pageBlock) parts.push(pageBlock);
    }

    return { totalPages, fullText: parts.join("\n\n"), pages };
  } catch (error) {
    console.error("[PDF] Server-side extraction failed:", error);
    return { totalPages: 0, fullText: "", pages: [] };
  }
}