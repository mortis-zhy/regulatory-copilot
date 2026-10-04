import { Router } from "express";
import { storagePut } from "../storage";
import { streamMiniMaxChat, type ChatMessage } from "../integrations/minimax";
import { parseWithRagAnything } from "../integrations/ragAnything";
import { renderPdf, renderWordHtml, type ReportPayload } from "../reports/export";
import { extractPdfTextServer } from "../ingestion/pdfExtract";
import { sidecarHealth, sidecarExtractDocs, sidecarVerify, buildSidecarReport, SIDECAR_URL } from "./sidecarClient";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const SYSTEM_PROMPT = `你是企业法规对比智能体（Regulatory Copilot）。所有回答必须按"结构对齐 → 内容对比 →专业参数 → 联网证据"四层组织。每条结论都要带原文锚点（章节号 / 页码 / 表格编号），并明确区分三类信息——【原文事实】、【模型推断】、【待人工确认】。不要凭空生成法规原文，不要把没有证据的联网信息当作最终结论；当模型无法验证时，必须使用【待人工确认】前缀并给出建议的核实途径。

【版本角色——最高优先级规则】
- A = GB 4785 草案 V4.3.5（新版）；B = GB 4785-2019（现行旧版）；C = UN R48-09（国际参照）
- 所有 changes 的语义 = **B → A**：oldExcerpt/原文 = B 的原文摘录，newExcerpt/新文 = A 的原文摘录
- C 的内容只写进 anchor（如"C=6.1.1"），绝对不要拼进 newExcerpt
- A 与 B 相同 = [保留]，不得作为 change 输出
- 每条 change 必须【条款级】：条款号 + 具体技术内容/数值（禁止"章节数不同"这类元数据作 change 标题）

【输出格式——必须严格遵守】你的每一次回答都必须：

第一部分：四层组织的 markdown 详细分析。其中"内容对比"必须**逐条列出具体改动**：
- 列出每一条**新增**的条款、定义、要求（草案 vs 现行版的"全新"内容）
- 列出每一条**修改**的条款（旧值/新值，包括数值、文字、范围）
- 列出每一条**删除**的条款（2019 版有、草案删除了什么）
- 列出每一条**引用关系变化**（章节 X 现在引用了章节 Y 而以前没有）
- 每一条改动都要带：旧文原文片段 + 新文原文片段 + 章节号 + 页码 + 是新增/修改/删除/引用变化

**绝对禁止**：输出**中途停止**！结构对齐部分完成后必须**立即进入内容对比**；内容对比完成后必须立即进入专业参数；专业参数完成后必须立即进入联网证据；最后输出 JSON 块。**任何阶段都不能说"完整对比结束"或类似总结性句子后停止输出**。

第二部分：在回答末尾必须输出一个 JSON 代码块（以 \`\`\`json 开始、以 \`\`\` 结束），其中必须包含以下三个数组，缺一不可：
   - "changes": 数组，每项含 id、title、type（"added"/"removed"/"modified"/"renumbered"）、severity（"high"/"medium"/"low"）、oldExcerpt、newExcerpt、anchor 字段。任何旧值≠新值的差别都是一条 change，**至少输出 30 条**。
   - "parameters": 数组，每项含 name、oldValue、newValue、unit、source 字段。**至少输出 25 条参数对比**。
   - "evidence": 数组，每项含 title、sourceName、sourceUrl、level 字段。`;



export function registerAgentRoutes(router: Router) {
  // Accept multipart/form-data so large PDFs bypass JSON body-size limits
  router.post("/api/agent/documents", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "file is required (multipart field name: file)" });
      const fileName = (req.body.fileName as string | undefined) || file.originalname;
      const mimeType = (req.body.mimeType as string | undefined) || file.mimetype || "application/octet-stream";
      const bytes = file.buffer;
      const stored = await storagePut(`regulatory-documents/${fileName}`, bytes, mimeType);
      let parsed;
      let parseError = "";
      let serverText = "";
      let serverPages = 0;

      // 1. Try RAG-Anything if configured
      try {
        parsed = await parseWithRagAnything({ fileName, mimeType, bytes });
      } catch (error) {
        parseError = error instanceof Error ? error.message : "Parser unavailable";
      }

      // 2. Server-side PDF text extraction (always try for PDFs, independent of RAG-Anything)
      if (mimeType === "application/pdf" || /\.pdf$/i.test(fileName)) {
        try {
          const result = await extractPdfTextServer(bytes);
          serverText = result.fullText;
          serverPages = result.totalPages;
          if (!serverText && !parsed) {
            parseError = parseError ? parseError + "; 本地解析也未返回文本" : "本地解析未返回文本";
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Server-side PDF extraction failed";
          if (!parseError) parseError = msg;
        }
      }

      // Persist the PDF to local disk so the MinerU sidecar can extract it.
      // Filename is hashed to avoid filesystem issues with Chinese names/spaces.
      let localFilePath: string | undefined;
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const crypto = await import("node:crypto");
        const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
        const dir = path.resolve(import.meta.dirname, "../uploaded-docs");
        fs.mkdirSync(dir, { recursive: true });
        localFilePath = path.join(dir, `${hash}.pdf`);
        if (!fs.existsSync(localFilePath)) {
          fs.writeFileSync(localFilePath, bytes);
        }
      } catch (e) {
        console.warn("[documents] local disk persist failed (MinerU path unavailable):", e);
      }

      return res.json({
        fileName,
        mimeType,
        size: bytes.length,
        storage: stored,
        parsed,
        parserStatus: parsed ? "complete" : (serverText ? "local_complete" : "needs_configuration"),
        parseError: parseError || undefined,
        serverExtractedText: serverText || undefined,
        serverPageCount: serverPages || undefined,
        localFilePath,
      });
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
          // 65K tokens = enough for 15+ detailed changes with old/new excerpts
          // plus the full JSON block (changes + parameters + evidence arrays).
          // MiniMax-M3 endpoint caps at 65K so we use the max.
          maxTokens: 65536,
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
      // V8 path: the client asks for the full regulatory comparison report.
      // The server ignores the chat payload and renders the last generated
      // report through htmlRenderV8 (the same renderer /report/render uses),
      // so the toolbar PDF button and the API produce byte-equivalent output.
      const body = req.body as { useV8?: boolean } & ReportPayload;
      if (body?.useV8) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const file = path.resolve(import.meta.dirname, "../reports/last-report.json");
        if (!fs.existsSync(file)) {
          return res.status(409).json({
            error: "尚未生成对比报告。请先在「法规对比任务」页生成完整报告，再导出 PDF。",
            code: "no_report",
          });
        }
        const { renderPdfFromReportV8 } = await import("../reports/htmlRenderV8");
        const report = JSON.parse(fs.readFileSync(file, "utf-8"));
        // Same integrity gate as /report/render — never hand a degraded
        // report to the user as if it were complete.
        const { buildTrustBundle } = await import("../reports/trustChecks");
        const { integrity } = buildTrustBundle(report.chapters ?? []);
        if (integrity.level === "blocked" && !req.query?.force) {
          return res.status(422).json({
            error: "报告完整性检查未通过，已阻止导出",
            code: "integrity_blocked",
            level: integrity.level,
            blockers: integrity.blockers.map((b) => ({ label: b.label, detail: b.detail })),
            hint: "确认可以导出请加 ?force=1；或重新生成报告。",
          });
        }
        const rawPdf = await renderPdfFromReportV8(report);
        return res
          .status(200)
          .set({
            "Content-Type": "application/pdf",
            // ASCII-only filename in the header — RFC 6266 forbids raw
            // non-ASCII bytes in header values (Chromium rejects it).
            // The browser-side link sets the Chinese display name instead.
            "Content-Disposition": `attachment; filename="GB4785-multiversion-comparison-report.pdf"`,
          })
          .send(rawPdf);
      }
      // Legacy path: chat-answer export via export.ts (kept for /report/word
      // parity and any external consumer that posts a ReportPayload).
      const bytes = await renderPdf(body as ReportPayload);
      res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.pdf` }).send(Buffer.from(bytes));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "PDF generation failed" });
    }
  });

  // ---------------------------------------------------------------------------
  // Multi-chapter report generation (SSE) + HTML→PDF rendering
  // ---------------------------------------------------------------------------

  /** POST /api/agent/report/generate/mineru — deterministic MinerU pipeline.
   *  Uses the Python sidecar (MinerU 4.0.6 + verification). Body:
   *  { documents: [{ label, fileName, filePath }], returnPdf?: bool }
   *  When `returnPdf` is true, responds with application/pdf; otherwise with
   *  the RenderableReport JSON (for the existing /report/render route). */
  router.post("/api/agent/report/generate/mineru", async (req, res) => {
    try {
      const docs = (Array.isArray(req.body?.documents) ? req.body.documents : []) as Array<{
        label: string;
        fileName: string;
        filePath: string;
      }>;
      if (docs.length < 2) {
        return res.status(400).json({ error: "documents[] (with label/fileName/filePath) required, >= 2" });
      }
      const healthy = await sidecarHealth();
      if (!healthy) {
        return res.status(503).json({
          error: `Python sidecar not reachable at ${SIDECAR_URL}. Start it: python python_service/main.py`,
        });
      }

      console.log(`[mineru-report] extracting ${docs.length} docs via sidecar...`);
      const extracted = await sidecarExtractDocs(docs);
      // cross-doc verification (numericChanges + topicColumns) — best-effort:
      // needs dist/diff-result.json + extract-cache which the CLI pipeline
      // pre-computes. If absent, fall back to extraction-only report.
      let verified: any;
      try {
        verified = await sidecarVerify();
        console.log(`[mineru-report] verified: ${verified.numericChanges?.length ?? 0} numeric changes, ${verified.topicColumns?.length ?? 0} topics`);
      } catch (e) {
        console.warn(`[mineru-report] verify unavailable (falling back to extraction-only): ${e}`);
      }
      const { report } = await buildSidecarReport(extracted, verified);
      console.log(`[mineru-report] report built (${report.chapters.length} chapters, ${report.appendices.length} appendices)`);

      // Persist for /report/last + re-render
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const dir = path.resolve(import.meta.dirname, "../reports");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "last-report.json"), JSON.stringify(report), "utf-8");
      } catch (e) {
        console.error("[mineru-report] persist failed:", e);
      }

      if (req.body?.returnPdf) {
        const { renderPdfFromReportV8 } = await import("../reports/htmlRenderV8");
        const rawPdf = await renderPdfFromReportV8(report);
        // Shared finalization with the CLI: pass-2 TOC page numbers, audit +
        // render gates, PDF metadata, bookmark outline — the customer gets
        // exactly the same artifact quality as the locally-generated report.
        const pdf = await finalizePdf(report, rawPdf);
        return res.status(200).set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.pdf`,
        }).send(pdf);
      }
      return res.json(report);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[mineru-report] failed:", error);
      return res.status(500).json({ error: msg });
    }
  });

  /** POST /api/agent/report/generate — SSE stream of ReportEvent. */
  router.post("/api/agent/report/generate", async (req, res) => {
    const docs = (Array.isArray(req.body?.documents) ? req.body.documents : []) as Array<{
      label: string;
      fileName: string;
      text: string;
    }>;
    if (docs.length === 0) {
      return res.status(400).json({ error: "documents[] (with full extracted text) is required" });
    }

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    try {
      // Regex extraction happens first so its stats arrive before the outline.
      const { extractAll } = await import("../ingestion/regexExtract");
      const extracted = extractAll(docs);
      const regexJson = JSON.stringify(
        {
          clauses: extracted.clauseIndex.slice(0, 400),
          numericValues: extracted.numericValues.slice(0, 600),
        },
        null,
        0,
      );

      const { generateReport } = await import("../reports/reportGenerator");

      // Collect chapters & appendices for the follow-up render call.
      const chapters: Array<{ id: number; title: string; markdown: string }> = [];
      const appendices: Array<{ id: string; title: string; markdown: string }> = [];
      let outline: unknown = null;

      // Client disconnect must NOT abort generation — a 25-minute run that the
      // browser stopped waiting for would otherwise lose everything. We keep
      // generating in the background, skip writes to the closed socket, and
      // always persist last-report.json at completion.
      const safeWrite = (payload: unknown) => {
        if (closed || res.writableEnded) return;
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          closed = true;
        }
      };

      for await (const ev of generateReport(docs, regexJson, (e) => void e)) {
        if (ev.type === "regex_stats") {
          ev.clauses = extracted.clauseIndex.length;
          ev.values = extracted.numericValues.length;
        }
        if (ev.type === "outline") outline = ev.outline;
        if (ev.type === "chapter_done") {
          chapters.push({ id: ev.id, title: ev.title, markdown: ev.markdown });
        }
        if (ev.type === "appendix_done") {
          appendices.push({ id: ev.id, title: ev.title, markdown: ev.markdown });
        }
        if (ev.type === "all_done") {
          // Assemble the full report, persist it (so PDF can be re-rendered
          // without a 20-minute regeneration), then stream it to the client.
          const report = {
            outline,
            chapters,
            appendices,
            sourceDocuments: docs.map((d) => ({
              label: d.label,
              name: d.fileName,
              meta: (d as { pageCount?: number; meta?: string }).meta ?? "",
            })),
            generatedAt: new Date().toLocaleString("zh-CN"),
          };

          // ── Persist gate ────────────────────────────────────────────
          // A mid-run failure (LLM 402/429/timeout) leaves placeholder text in
          // `chapters`. Writing that to disk would silently destroy the last
          // good report — the next render would then serve a mostly-empty
          // document. Detect it and keep the previous artifact.
          const failedChapters = chapters.filter(
            (c: { markdown?: string }) =>
              /本章生成失败|MiniMax request failed|生成失败[:：]/.test(c?.markdown ?? ""),
          );
          const shouldPersist = failedChapters.length === 0 || failedChapters.length < chapters.length / 2;
          if (!shouldPersist) {
            console.error(
              `[report] generation degraded: ${failedChapters.length}/${chapters.length} chapters failed — NOT overwriting last-report.json`,
            );
            safeWrite({
              type: "error",
              message: `生成失败：${failedChapters.length}/${chapters.length} 个章节未成功，已保留上一份报告。`,
              code: "generation_degraded",
              failedChapters: failedChapters.map((c: { title: string }) => c.title),
            });
            if (!res.writableEnded) res.end();
            return;
          }

          try {
            const fs = await import("node:fs");
            const path = await import("node:path");
            // dist/index.mjs → repo/reports/
            const dir = path.resolve(import.meta.dirname, "../reports");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "last-report.json"), JSON.stringify(report), "utf-8");
            console.log(`[report] saved last-report.json (${chapters.length} chapters, ${appendices.length} appendices)`);
            if (failedChapters.length) {
              console.warn(
                `[report] persisted with ${failedChapters.length} degraded chapters: ${failedChapters
                  .map((c: { title: string }) => c.title)
                  .join(", ")}`,
              );
            }
            // No bundle regeneration needed: htmlRenderV8 extracts typed tables
            // in-process from whatever report it is handed (typedTables.ts), so
            // the render path has no external file dependency and cannot go stale.
          } catch (e) {
            console.error("[report] failed to persist report:", e);
          }
          safeWrite({ type: "report_complete", ...report });
        }
        safeWrite(ev);
      }
      if (!closed && !res.writableEnded) res.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!closed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
        res.end();
      }
    }
  });

  /** GET /api/agent/report/last — return the most recently generated report (if any). */
  router.get("/api/agent/report/last", async (_req, res) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = path.resolve(import.meta.dirname, "../reports/last-report.json");
      if (!fs.existsSync(file)) return res.status(404).json({ error: "no report generated yet" });
      res.type("application/json").send(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * GET /api/agent/report/trust — 审阅工作台数据源。
   *
   * 把三块"埋在 PDF 第 10 章深处"的可信度信息抬到 API 层:
   *   1. dashboard  — verify_report.json 的 5 类闭环统计 + 告警清单
   *   2. errata      — §11.3.0 同文勘误逐条(B 截断值 / A 完整值 / 降级依据)
   *   3. rumors      — §11.0 网传指标核验(⚠ 行业流传但两版原文无出处)
   * 全部为**只读投影**:不改写报告,只把已有结论结构化给前端。
   */
  router.get("/api/agent/report/trust", async (_req, res) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const repoRoot = path.resolve(import.meta.dirname, "../..");
      const reportFile = path.resolve(import.meta.dirname, "../reports/last-report.json");
      if (!fs.existsSync(reportFile)) return res.status(404).json({ error: "no report generated yet" });
      const report = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
      // PRIMARY: in-process trust analysis (trustChecks.ts) — no external file.
      const { buildTrustBundle } = await import("../reports/trustChecks");
      const inProc = buildTrustBundle(report.chapters ?? []);
      const md = (report.chapters ?? []).map((c: { markdown?: string }) => c.markdown ?? "").join("\n");
      const counts = inProc.counts;
      const total = inProc.total;
      const errata = inProc.errata as Array<Record<string, unknown>>;
      const rumors = inProc.rumors;
      let warnings = inProc.warnings as Array<{ label: string; status: string; detail: string; evidence?: string }>;

      // ---------- 2/3. 同文勘误 + 网传指标：来自 trustChecks.ts ----------
      // ---------- 4. verify_report.json 告警（补充 PDF↔源 的校验项） ----------
      // The TS bundle already covers report-internal checks. verify_report.json
      // adds the source-PDF cross-checks (page counts, voltages, clause pages)
      // which legitimately need PyMuPDF. Merge without duplicating labels.
      const verifyFile = path.join(repoRoot, "verify_report.json");
      if (fs.existsSync(verifyFile)) {
        try {
          const vr = JSON.parse(fs.readFileSync(verifyFile, "utf-8"));
          const seen = new Set(warnings.map((w) => w.label));
          for (const c of vr.checks ?? []) {
            if (c.status !== "warn" && c.status !== "fail") continue;
            if (seen.has(c.label)) continue;
            seen.add(c.label);
            warnings.push({
              label: c.label,
              status: c.status,
              detail: c.detail,
              evidence: c.source_evidence,
            });
          }
        } catch { /* 诊断文件损坏时静默降级 */ }
      }

      // ---------- 5. 合并人工审阅结论 ----------
      const verdictFile = path.join(path.resolve(import.meta.dirname, "../reports"), "verdicts.json");
      const human: Record<string, { verdict: string; note: string; at: string }> = {};
      if (fs.existsSync(verdictFile)) {
        try { Object.assign(human, JSON.parse(fs.readFileSync(verdictFile, "utf-8"))); } catch { /* ignore */ }
      }
      // 人工确认的勘误 → 从 candidate 移到 confirmed
      let humanConfirmed = 0;
      for (const e of errata) {
        const v = human[`errata:${e.no}`];
        if (v?.verdict === "confirmed") { e.humanVerdict = "confirmed"; e.humanNote = v.note; humanConfirmed++; }
        else if (v?.verdict === "rejected") { e.humanVerdict = "rejected"; e.humanNote = v.note; }
        else e.humanVerdict = "pending";
      }

      res.type("application/json").send({
        dashboard: {
          counts,
          total,
          candidateShare: total ? Math.round((counts.candidate / total) * 100) : 0,
          humanConfirmed,
        },
        errata,
        rumors,
        warnings,
        integrity: inProc.integrity,
        // Entry-level ledger: every dashboard count traces back to rows here,
        // plus the per-item worklist and the self-report reconciliation.
        ledger: inProc.ledger,
        human,
        generatedAt: report.generatedAt ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * POST /api/agent/report/trust/verdict — 人工审阅结论回写。
   * 前端在"假差异工作台"点确认/驳回后调用,结果落 reports/verdicts.json,
   * 下次拉取 /trust 时合并(人工确认的勘误从 ⚠ 升级为 ✅)。
   */
  router.post("/api/agent/report/trust/verdict", async (req, res) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = path.resolve(import.meta.dirname, "../reports");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "verdicts.json");
      const body = req.body as { id?: string; verdict?: "confirmed" | "rejected"; note?: string };
      if (!body?.id || !body?.verdict) return res.status(400).json({ error: "id and verdict required" });

      let store: Record<string, unknown> = {};
      if (fs.existsSync(file)) {
        try { store = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { store = {}; }
      }
      store[body.id] = { verdict: body.verdict, note: body.note ?? "", at: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
      res.type("application/json").send({ ok: true, id: body.id, verdict: body.verdict, total: Object.keys(store).length });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * POST /api/agent/diff — structured extraction + programmatic B→A diff.
   * Body: { documents: [{ label, fileName, text }] } (full extracted texts).
   * Returns deterministic changes/parameters (cached extractions → fast).
   */
  router.post("/api/agent/diff", async (req, res) => {
    try {
      const documents = (Array.isArray(req.body?.documents) ? req.body.documents : []) as Array<{
        label: string;
        fileName: string;
        text: string;
      }>;
      if (documents.length < 2) {
        return res.status(400).json({ error: "documents[] with at least 2 full texts required" });
      }
      const { extractStructured } = await import("../ingestion/structuredExtract");
      const { diffDocuments } = await import("../reports/diffEngine");
      const structs = [];
      for (const d of documents) {
        structs.push(await extractStructured(d.label, d.fileName, d.text));
      }
      const [aDoc, bDoc, ...rest] = structs;
      const diff = diffDocuments(aDoc, bDoc, rest[0]);
      res.json(diff);
    } catch (error) {
      console.error("[diff]", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** POST /api/agent/report/render — receive a RenderableReport, return a PDF. */
  router.post("/api/agent/report/render", async (req, res) => {
    try {
      // ── Integrity gate ──────────────────────────────────────────────
      // A report that failed extraction (empty chapters, no page anchors,
      // no A/B/C markers, no verdicts) still renders into a confident-looking
      // 100-page PDF. Refuse unless the caller explicitly overrides, so a
      // degraded generation can't silently ship. ?force=1 still renders but
      // the UI surfaces the blockers.
      const { buildTrustBundle } = await import("../reports/trustChecks");
      const { integrity } = buildTrustBundle(req.body?.chapters ?? []);
      if (integrity.level === "blocked" && !req.query?.force) {
        return res.status(422).json({
          error: "报告完整性检查未通过，已阻止渲染",
          code: "integrity_blocked",
          level: integrity.level,
          blockers: integrity.blockers.map((b) => ({ label: b.label, detail: b.detail })),
          hint: "确认可以导出请加 ?force=1；或重新生成报告。",
        });
      }
      if (integrity.level !== "ok") {
        console.warn(
          `[report/render] integrity=${integrity.level}: ${integrity.blockers
            .map((b) => b.label)
            .join(", ")}`,
        );
      }

      const { renderPdfFromReportV8 } = await import("../reports/htmlRenderV8");
      const rawPdf = await renderPdfFromReportV8(req.body);
      res
        .status(200)
        .set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.pdf`,
        })
        .send(rawPdf);
    } catch (error) {
      console.error("[report/render]", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "PDF render failed" });
    }
  });
}