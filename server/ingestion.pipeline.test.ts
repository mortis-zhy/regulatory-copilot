import { describe, expect, it } from "vitest";
import { chooseParser } from "./ingestion/pipeline";

describe("document parser routing", () => {
  it("routes multimodal PDFs to the RAG-compatible adapter", () => {
    expect(chooseParser("application/pdf")).toBe("rag-anything");
  });

  it("routes DOCX files to the native parser", () => {
    expect(chooseParser("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("native");
  });

  it("can disable multimodal parsing for lightweight ingestion", () => {
    expect(chooseParser("application/pdf", false)).toBe("mineru");
  });
});
