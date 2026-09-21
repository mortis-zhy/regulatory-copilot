export type ParsedBlockKind = "heading" | "paragraph" | "table" | "figure" | "footnote" | "appendix";

export type ParsedBlock = {
  stableKey: string;
  kind: ParsedBlockKind;
  level: number;
  title?: string;
  text: string;
  pageNumber?: number;
  bbox?: [number, number, number, number];
  confidence: number;
  children?: ParsedBlock[];
};

export type ParseRequest = {
  documentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  language?: string;
};

export type ParseResult = {
  documentId: number;
  parser: "native" | "mineru" | "rag-anything";
  parserVersion: string;
  blocks: ParsedBlock[];
  warnings: string[];
  coverage: { pages: number; parsedPages: number; lowConfidencePages: number };
};

export interface DocumentParserAdapter {
  parse(request: ParseRequest): Promise<ParseResult>;
}

/**
 * Integration boundary for enterprise-kb-v2 style services.
 * The web app keeps the document lifecycle and evidence governance here;
 * MinerU/RAG-Anything can be connected through this adapter without
 * coupling the product UI to a particular parser runtime.
 */
export class HttpDocumentParserAdapter implements DocumentParserAdapter {
  constructor(private readonly endpoint: string, private readonly apiKey?: string) {}

  async parse(request: ParseRequest): Promise<ParseResult> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/parse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Document parser failed with ${response.status}`);
    return response.json() as Promise<ParseResult>;
  }
}

export function chooseParser(mimeType: string, multimodal = true): "native" | "mineru" | "rag-anything" {
  if (multimodal && ["application/pdf", "image/tiff", "image/png", "image/jpeg"].includes(mimeType)) return "rag-anything";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "native";
  return "mineru";
}
