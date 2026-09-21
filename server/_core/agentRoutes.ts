import { Router } from "express";
import { storagePut } from "../storage";
import { streamMiniMaxChat, type ChatMessage } from "../integrations/minimax";
import { parseWithRagAnything } from "../integrations/ragAnything";
import { renderPdf, renderWordHtml, type ReportPayload } from "../reports/export";

const SYSTEM_PROMPT = `你是企业法规对比智能体（Regulatory Copilot）。所有回答必须按"结构对齐 → 内容对比 → 专业参数 → 联网证据"四层组织。每条结论都要带原文锚点（章节号 / 页码 / 表格编号），并明确区分三类信息——【原文事实】、【模型推断】、【待人工确认】。不要凭空生成法规原文，不要把没有证据的联网信息当作最终结论；当模型无法验证时，必须使用【待人工确认】前缀并给出建议的核实途径。`;

export function registerAgentRoutes(router: Router) {
  router.post("/api/agent/documents", async (req, res) => {
    try {
      const { fileName, mimeType, dataBase64 } = req.body as { fileName?: string; mimeType?: string; dataBase64?: string };
      if (!fileName || !mimeType || !dataBase64) return res.status(400).json({ error: "fileName, mimeType and dataBase64 are required" });
      const bytes = Buffer.from(dataBase64, "base64");
      const stored = await storagePut(`regulatory-documents/${fileName}`, bytes, mimeType);
      let parsed;
      let parseError = "";
      try {
        parsed = await parseWithRagAnything({ fileName, mimeType, bytes });
      } catch (error) {
        parseError = error instanceof Error ? error.message : "Parser unavailable";
      }
      return res.json({ fileName, mimeType, size: bytes.length, storage: stored, parsed, parserStatus: parsed ? "complete" : "needs_configuration", parseError });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Document upload failed" });
    }
  });

  router.post("/api/agent/chat/stream", async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages as ChatMessage[] : [];
    if (!messages.length) return res.status(400).json({ error: "messages are required" });
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let finished = false;
    res.on("close", () => { finished = true; });
    try {
      for await (const chunk of streamMiniMaxChat(
        [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        {
          temperature: 0.15,
          onReasoning: (delta) => {
            if (!finished && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ reasoning: delta })}\n\n`);
            }
          },
        },
      )) {
        if (finished || res.writableEnded) break;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }
      if (!finished && !res.writableEnded) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      if (!finished && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : "MiniMax stream failed" })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  router.post("/api/agent/report/word", (req, res) => {
    const report = req.body as ReportPayload;
    const html = renderWordHtml(report);
    res.status(200).set({ "Content-Type": "application/msword; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.doc` }).send(html);
  });

  router.post("/api/agent/report/pdf", async (req, res) => {
    try {
      const bytes = await renderPdf(req.body as ReportPayload);
      res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.pdf` }).send(Buffer.from(bytes));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "PDF generation failed" });
    }
  });
}