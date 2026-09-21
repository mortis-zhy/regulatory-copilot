import { describe, expect, it } from "vitest";
import { renderPdf, renderWordHtml, type ReportPayload } from "./reports/export";

const report: ReportPayload = {
  title: "测试法规报告",
  sourceDocuments: [{ name: "草案", version: "V1" }],
  summary: "测试摘要",
  changes: [{ id: "CHG-1", title: "参数变化", type: "数值变化", severity: "高", oldText: "1,500 mm", newText: "1,600 mm", impact: "影响支架", source: "p.3 表 7" }],
  parameters: [{ name: "高度", oldValue: "1500", newValue: "1600", unit: "mm", impact: "高", source: "表 7" }],
  evidence: [{ title: "官方来源", source: "标准系统", retrievedAt: "2026-09-21" }],
};

describe("report exports", () => {
  it("renders Word-compatible HTML with comparison content", () => {
    const html = renderWordHtml(report);
    expect(html).toContain("测试法规报告");
    expect(html).toContain("1,600 mm");
    expect(html).toContain("专业参数");
  });

  it("renders a non-empty PDF", async () => {
    const bytes = await renderPdf(report);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
  });
});
