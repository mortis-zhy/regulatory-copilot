import { Router } from "express";
import { storagePut } from "../storage";
import { streamMiniMaxChat, type ChatMessage } from "../integrations/minimax";
import { runAgentLoop } from "../reports/agentLoop";
import { AGENT_SYSTEM_PROMPT } from "../reports/agentPrompt";
import { toolSchemas } from "../reports/agentTools";
import { parseWithRagAnything } from "../integrations/ragAnything";
import { renderPdf, renderWordHtml, type ReportPayload } from "../reports/export";
import { extractPdfTextServer } from "../ingestion/pdfExtract";
import { sidecarHealth, ensureSidecar, sidecarExtractDocs, sidecarVerify, buildSidecarReport, SIDECAR_URL } from "./sidecarClient";
import { runDeliveryGate } from "./deliveryGate";
// 版本角色（谁是新版、谁是现行、谁是参照）—— **从声明取**。
// 原来写在系统提示词里，换标准时那句提示会**继续说旧标准**。
import { REPORT_META } from "../reports/reportMeta";
import { PROJECT_ROOT, REPORT_FILE, UPLOADED_DOCS_DIR } from "./projectRoot";
import { taskIdOf, resolveReportFile, taskReportFile, taskDraftFile, taskDir, readTaskUploads, appendTaskUpload } from "./taskContext";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * 语料（懒加载一次）—— 上传时认版本要用。
 *
 * 为什么认版本要**对着语料比**而不是看文件名：
 * 认版本这件事项目里有三套实现（sidecar 按文件名、clause_split 按内容标记、
 * matrix 按内容相似度），而**只有内容相似度那套不需要为新标准写任何声明** ——
 * 语料里有哪几版，就认哪几版。
 *
 * 缓存的理由：语料 11.6 MB，每个上传请求都重新解析一遍是白花的 CPU。
 */
let CORPUS_CACHE: { data: Record<string, any> | null } | null = null;

async function loadCorpus(): Promise<Record<string, any> | null> {
  if (CORPUS_CACHE) return CORPUS_CACHE.data;
  CORPUS_CACHE = { data: null };
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const p = path.join(PROJECT_ROOT, "dist", "mineru-v4-data.json");
    if (fs.existsSync(p)) {
      CORPUS_CACHE.data = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  } catch {
    /* 语料不在 → 认不出版本（不影响别的功能） */
  }
  return CORPUS_CACHE.data;
}

/**
 * 参考件的正文（**懒加载 + 缓存**）—— 用来认「同一份标准的另一个副本」。
 *
 * 参考件是**语料里各版的源 PDF**（`uploaded-docs/<sha 前 16 位>.pdf`），
 * 文本用 **MuPDF** 取 —— 与上传文件的文本**同一种表示**。
 *
 * 为什么强调「同一种表示」：拿 MinerU 的语料文本去比 MuPDF 的上传文本，
 * 实测相似度只有 0.21~0.24（那是两种排版版本在比）；
 * 同表示互比（跨页采样）实测：同一份 **1.00** · 同标准的兄弟版 **0.52** · 跨标准 **0.14~0.16**。
 */
let REF_TEXTS_CACHE: { refs: Array<{ label: string; text: string }> | null } | null = null;

async function loadReferenceTexts(): Promise<Array<{ label: string; text: string }>> {
  if (REF_TEXTS_CACHE) return REF_TEXTS_CACHE.refs ?? [];
  REF_TEXTS_CACHE = { refs: null };
  const refs: Array<{ label: string; text: string }> = [];
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { extractPdfTextServer } = await import("../ingestion/pdfExtract");
    const corpus = await loadCorpus();
    for (const [ver, doc] of Object.entries(corpus ?? {})) {
      const sha = String(doc?.sourceSha256 ?? "").slice(0, 16);
      if (!sha) continue;
      const p = path.join(PROJECT_ROOT, "uploaded-docs", `${sha}.pdf`);
      if (!fs.existsSync(p)) continue;
      const r = await extractPdfTextServer(fs.readFileSync(p));
      if (r?.fullText) refs.push({ label: ver, text: r.fullText });
    }
  } catch {
    /* 参考件取不到 → 只剩 sha256 那条判据 */
  }
  REF_TEXTS_CACHE.refs = refs;
  return refs;
}

/** 上传的文件是哪一版？—— **按内容认**（先 sha256，再相似度）。 */
async function recognizeUploadVersion(
  bytes: Buffer,
  text: string,
): Promise<{ label: string | null; score: number; source: string; reason: string }> {
  const { recognizeBySha256, recognizeByReferences } = await import("../reports/versionRecognize");
  const crypto = await import("node:crypto");
  const corpus = await loadCorpus();
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");

  // ① 逐字节相同 —— 零歧义，最常见
  const bySha = recognizeBySha256(sha, corpus);
  if (bySha.label) {
    return { label: bySha.label, score: 1, source: bySha.source, reason: bySha.reason };
  }

  // ② 同一份标准的另一个副本 —— 内容相似度
  const refs = await loadReferenceTexts();
  const g = recognizeByReferences(text, refs);
  return {
    label: g.label,
    score: Number(g.score.toFixed(3)),
    source: g.source,
    reason: g.reason,
  };
}

/**
 * 版本角色 —— **从声明取**（`versions[].desc`）。
 * 原来这一行写死在提示词里，换标准时它会**继续说旧标准**。
 */
const VERSION_ROLE_LINE = REPORT_META.versions
  .map((v) => `- ${v.key} = ${v.desc}`)
  .join("；");

const SYSTEM_PROMPT = `你是企业法规对比智能体（Regulatory Copilot）。所有回答必须按"结构对齐 → 内容对比 →专业参数 → 联网证据"四层组织。每条结论都要带原文锚点（章节号 / 页码 / 表格编号），并明确区分三类信息——【原文事实】、【模型推断】、【待人工确认】。不要凭空生成法规原文，不要把没有证据的联网信息当作最终结论；当模型无法验证时，必须使用【待人工确认】前缀并给出建议的核实途径。

【版本角色——最高优先级规则】
${VERSION_ROLE_LINE}
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



/**
 * **这次问答的任务上下文** —— 取证工具靠它判断
 * 「当前任务上传的文件，是不是案例包管的那一套」。
 *
 * ## 为什么要判
 *
 * 取证工具读的是**案例包**的索引与台账 —— 那是**某一套标准**的资料。
 * 上传的是别的法规时，那些资料是**另一套标准**的 ✗ ——
 * 拿它们回答 = 「查到旧资料」（同事 issue #2 的原话）✓。
 *
 * 判据与出报告那条路**同一处实现**（`matchCasePack`）✓ ——
 * 两处各判一次，迟早会判得不一样 ✗。
 */
async function taskToolContext(
  taskId: string,
  claimed?: Array<{ fileName?: string; sha256?: string }>,
) {
  // **优先用客户端报上来的「当前这批文件」** ✓ ——
  // 客户端最清楚用户**现在**要问的是哪几个文件 ✓
  // （用户删掉一份再问，服务器记的清单里那份还在 ✗）。
  //
  // 客户端报来的指纹要**验**：文件必须真的在 `uploaded-docs/` 里 ✓ ——
  // 否则客户端可以随口报一个指纹，让判定结果失去意义 ✗。
  let docs: { key: string; sha256: string; name: string }[] = [];
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const seen = new Set<string>();
    for (const c of claimed ?? []) {
      const sha = String(c?.sha256 ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) continue;
      if (seen.has(sha)) continue;
      // **验真**：这份文件必须真的上传过 ✓
      const onDisk = path.join(UPLOADED_DOCS_DIR, `${sha.slice(0, 16)}.pdf`);
      if (!fs.existsSync(onDisk)) continue;
      seen.add(sha);
      docs.push({ key: String.fromCharCode(65 + docs.length), sha256: sha, name: String(c?.fileName ?? "") });
    }
  } catch {
    /* 验不了就当没有 ✓ */
  }
  // 客户端没报（老用法 / CLI）→ 用服务器记的清单 ✓
  if (!docs.length) {
    docs = readTaskUploads(taskId).map((u, i) => ({
      key: String.fromCharCode(65 + i),
      sha256: u.sha256,
      name: u.fileName,
    }));
  }
  if (!docs.length) {
    // 这个任务**还没上传过文件** → 判不了 → 不拦（老用法照旧 ✓）。
    return { taskId, casePack: null };
  }
  try {
    const { matchCasePack, casePackSourceFiles } = await import("../reports/casePack");
    const m = matchCasePack(docs);
    return {
      taskId,
      casePack: {
        applies: m.applies,
        casePackId: m.casePackId,
        family: m.family,
        reason: m.reason,
        sourceFiles: casePackSourceFiles().map((x) => x.fileName).filter(Boolean),
      },
    };
  } catch (e) {
    console.warn("[agent] 案例包判定失败（不拦）:", String((e as Error)?.message ?? e).slice(0, 160));
    return { taskId, casePack: null };
  }
}

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
        // 落点必须是**仓库根的 uploaded-docs/** —— 回源复核层（loadSourceCorpus）
        // 与 Python 审计器读的就是那里。写到 server/uploaded-docs/ 的话，
        // **网站上传的新标准管线根本看不见**（认不出是哪一版、复核不了取值）。
        const dir = UPLOADED_DOCS_DIR;
        fs.mkdirSync(dir, { recursive: true });
        localFilePath = path.join(dir, `${hash}.pdf`);
        if (!fs.existsSync(localFilePath)) {
          fs.writeFileSync(localFilePath, bytes);
        }
        // **记进这个任务的清单** —— 取证时要靠它判「这份输入是不是案例包管的」。
        //
        // 上传的文件本身早就按**内容哈希**存了 ✓（不同文件不会互相顶掉）；
        // 缺的是「**哪些文件属于这次任务**」这一条 ✗ ——
        // 没有它，服务器就分不清「这次问的是哪一套文件」。
        appendTaskUpload(taskIdOf(req), {
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          fileName,
          at: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("[documents] local disk persist failed (MinerU path unavailable):", e);
      }

      return res.json({
        fileName,
        mimeType,
        size: bytes.length,
        // **文件指纹** —— 客户端要拿它告诉服务器「这次任务用的是哪些文件」✓
        // （同事 issue #2：证据要能回到**当前任务的文件** ✓）
        sha256: (() => {
          try {
            return require("node:crypto").createHash("sha256").update(bytes).digest("hex");
          } catch {
            return undefined;
          }
        })(),
        storage: stored,
        parsed,
        parserStatus: parsed ? "complete" : (serverText ? "local_complete" : "needs_configuration"),
        parseError: parseError || undefined,
        serverExtractedText: serverText || undefined,
        serverPageCount: serverPages || undefined,
        localFilePath,
        // **上传时就认版本** —— 不等四十分钟后看一份矩阵空掉的报告。
        // 判据是**内容**（对着语料比），不是文件名：
        // 用户把文件改名是很普通的事，而按文件名认版本会让整个流程在最后一步失败。
        versionGuess: serverText ? await recognizeUploadVersion(bytes, serverText) : undefined,
      });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Document upload failed" });
    }
  });

  router.post("/api/agent/chat/stream", async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages as ChatMessage[] : [];
    if (!messages.length) return res.status(400).json({ error: "messages are required" });
    // 这条端点是**旧的一问一答**路径：模型看不到项目数据，只凭训练记忆回答。
    // 它给「快速草稿」用（网页版的 diff 生成器仍走它）。
    // **要能回源核实的问答请走 /api/agent/chat/agent**（带工具调用）。
    res.set("X-Agent-Mode", "unverified-draft");
    // The Settings panel exposes 模型 and Temperature, but the values were
    // dropped on the floor here — the request only ever carried `messages`, so
    // picking a model or dragging the slider changed nothing. Accept both and
    // pass them through; streamMiniMaxChat falls back to ENV.minimaxModel when
    // model is omitted, and a bad temperature is clamped rather than rejected
    // so a stale client can still get an answer.
    const model = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined;
    const rawTemp = Number(req.body?.temperature);
    const temperature = Number.isFinite(rawTemp) ? Math.min(2, Math.max(0, rawTemp)) : undefined;
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
          model,
          temperature: temperature ?? 0.15,
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

  /**
   * 取证型 agent —— **先取证，再回答**。
   *
   * 与 `/api/agent/chat/stream` 的区别：那个是「一问一答」，模型看不到项目数据，
   * 只能凭训练记忆回答（v1 事故的根源）。这个让模型自己调**只读**工具：
   * 查条款原文、查引文在哪一页、查覆盖台账、查差值判定 ——
   * 每个事实都回源到源 PDF 的具体页码。
   *
   * SSE 事件：reasoning / content / tool_call / tool_result / done / error
   */
  router.post("/api/agent/chat/agent", async (req, res) => {
    const messages = Array.isArray(req.body?.messages)
      ? (req.body.messages as ChatMessage[])
      : [];
    if (!messages.length) {
      return res.status(400).json({ error: "messages are required" });
    }
    const model =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model.trim()
        : undefined;
    const rawTemp = Number(req.body?.temperature);
    const temperature = Number.isFinite(rawTemp) ? Math.min(2, Math.max(0, rawTemp)) : undefined;
    const maxRounds = Number(req.body?.maxRounds);
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
      for await (const ev of runAgentLoop({
        messages,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        model,
        temperature: temperature ?? 0.2,
        maxRounds: Number.isFinite(maxRounds) ? maxRounds : 6,
        // **这次问答的上下文**（同事 issue #2 完成标准 1）——
        // 工具据此判断「这份输入是不是案例包管的」，
        // 并在每条结果里带上**证据来自哪个文件** ✓。
        toolContext: await taskToolContext(
          taskIdOf(req),
          Array.isArray(req.body?.documents) ? req.body.documents : undefined,
        ),
      })) {
        if (finished || res.writableEnded) break;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (error) {
      if (!finished && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n\n`,
        );
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /** 工具清单 —— 前端可以显示「agent 能做什么」，也让闸门能查它。 */
  router.get("/api/agent/chat/agent/tools", (_req, res) => {
    res.json({ tools: toolSchemas() });
  });

  router.post("/api/agent/report/word", (req, res) => {
    try {
      const report = (req.body ?? {}) as ReportPayload;
      if (!report || typeof report !== "object") {
        return res.status(400).json({ error: "请求体必须是 JSON 对象", code: "bad_payload" });
      }
      const hasContent = typeof report.content === "string" && report.content.trim().length > 0;
      const hasFindings = Array.isArray(report.changes)
        || Array.isArray(report.parameters)
        || Array.isArray(report.evidence);
      if (!hasContent && !hasFindings) {
        return res.status(400).json({
          error: "请求体缺少可导出内容（需要 content 或 changes/parameters/evidence）",
          code: "empty_payload",
        });
      }
      const html = renderWordHtml(report);
      res.status(200).set({ "Content-Type": "application/msword; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''regulatory-comparison-report.doc` }).send(html);
    } catch (error) {
      // Without this the express default handler answers with a raw 500 HTML
      // page — the client shows "报告生成失败" with no idea what went wrong.
      res.status(500).json({
        error: error instanceof Error ? error.message : "Word generation failed",
        code: "word_render_failed",
      });
    }
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
        // **读这个任务的那一份**（不带任务 id 的老用法 = 共享路径 ✓）。
        // 绝不落回共享的那份 —— 那就是「拿别的任务的报告当自己的」✗。
        const file = resolveReportFile(taskIdOf(req));
        if (!fs.existsSync(file)) {
          return res.status(409).json({
            error: "尚未生成对比报告。请先在「法规对比任务」页生成完整报告，再导出 PDF。",
            code: "no_report",
          });
        }
        const { renderPdfFromReportV8 } = await import("../reports/htmlRenderV8");
        const report = JSON.parse(fs.readFileSync(file, "utf-8"));
        // **护栏**：存着的这份必须是**已核验**的那一条管线出来的。
        //
        // 两条管线写同一个文件，快速草稿（llm-sse）会把 MinerU 的产物**覆盖掉**。
        // `/report/last` 早就有 `?prefer=mineru` 的护栏，
        // 但**这个导出端点没有** —— 于是同事跑一次草稿，
        // 点「下载 PDF」拿到的就是**未经回源复核的 LLM 草稿**，
        // 而界面上它长得跟交付件一模一样。
        //
        // 那是这个项目最贵的一类错：**安静地给出一份未经核验的东西**。
        const prefer = typeof req.query?.prefer === "string" ? req.query.prefer : "mineru";
        const actual = report.generator ?? "unknown";
        if (prefer !== actual) {
          return res.status(409).json({
            error:
              `当前存着的报告是「${actual}」生成的，不是「${prefer}」—— ` +
              `未经回源复核的草稿不能当作交付件导出。`,
            code: "generator_mismatch",
            generator: actual,
            hint: "用 MinerU 高精度路径重新生成，或加 ?prefer=llm-sse 明确接受这份草稿",
          });
        }
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
        // 文件名**从报告的源文档清单派生** —— 换一套新标准时自动跟着变。
        // 原来这里写死 "GB4785-multiversion-comparison-report.pdf"，
        // 于是换标准后下载下来的文件名字里还写着 GB 4785。
        const { contentDisposition, reportFileNameHeader } = await import("../reports/reportFileName");
        return res
          .status(200)
          .set({
            "Content-Type": "application/pdf",
            // RFC 6266：ASCII 兜底 + filename*=UTF-8'' 正式名（浏览器优先用它）。
            // 非 ASCII 字节不能直接进 header 值（Chromium 会拒绝）。
            "Content-Disposition": contentDisposition(report, "pdf"),
            // 自定义头带 UTF-8 原名，客户端直接拿来当 a.download
            // 百分号编码 —— Node 的 HTTP 层拒绝非 ASCII 的 header 值
            "X-Report-Filename": reportFileNameHeader(report, "pdf"),
          })
          .send(rawPdf);
      }
      // Legacy path: chat-answer export via export.ts (kept for /report/word
      // parity and any external consumer that posts a ReportPayload).
      // An empty payload used to reach the renderer and surface as 500 with a
      // stack-trace message; reject it up front as a client error instead.
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "请求体必须是 JSON 对象" });
      }
      const hasContent = typeof (body as { content?: unknown }).content === "string"
        && (body as { content: string }).content.trim().length > 0;
      const hasFindings = Array.isArray((body as { changes?: unknown }).changes)
        || Array.isArray((body as { parameters?: unknown }).parameters)
        || Array.isArray((body as { evidence?: unknown }).evidence);
      if (!hasContent && !hasFindings) {
        return res.status(400).json({
          error: "请求体缺少可导出内容（需要 content 或 changes/parameters/evidence）",
          code: "empty_payload",
        });
      }
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
      // The sidecar is a separate Python process and has died between requests
      // several times in one session (empty log, no traceback). Try to bring it
      // back before failing, so a transient crash doesn't surface as a 503 the
      // user has to fix by hand.
      const healthy = (await sidecarHealth()) || (await ensureSidecar());
      if (!healthy) {
        return res.status(503).json({
          error: `Python sidecar not reachable at ${SIDECAR_URL}. Start it: python python_service/main.py`,
        });
      }

      // ---- 案例包判定（**先判再做**）----
      //
      // 上传的文件是不是本案例包（GB 4785 那套专用资料）管的文件？
      //
      // 不是 → **422 + 人话理由**（不是 500）。
      // 先判的理由：抽取要 1–3 分钟/份，而核验（sidecarVerify）读的是
      // **仓库里 GB 的**结论 —— 对着别的法规跑它，出来的就是错的。
      const { matchCasePack } = await import("../reports/casePack");
      const { createHash } = await import("node:crypto");
      const fs2 = await import("node:fs");
      const caseDocs = docs.map((d) => {
        let sha: string | undefined;
        try {
          sha = createHash("sha256").update(fs2.readFileSync(d.filePath)).digest("hex");
        } catch {
          sha = undefined;
        }
        // 文件名也带上 —— 相似度被 OCR 噪声吃掉时，
        // **声明里的签名**能在族内再判一次 ✓（见 casePack.ts）。
        return { key: d.label, sha256: sha, name: d.fileName };
      });
      const caseDecision = matchCasePack(caseDocs);
      if (!caseDecision.applies) {
        console.warn(
          `[mineru-report] 案例包不适用（${caseDecision.casePackId}）：\n${caseDecision.reason}`,
        );
        return res.status(422).json({
          error: caseDecision.reason,
          code: "case_pack_not_configured",
          casePack: {
            id: caseDecision.casePackId,
            family: caseDecision.family,
            perDoc: caseDecision.perDoc,
          },
        });
      }

      console.log(`[mineru-report] extracting ${docs.length} docs via sidecar...`);
      const extracted = await sidecarExtractDocs(docs);
      // 文件名派生的两处实现 —— 与 /report/render 同一处，不各写一份。
      const { contentDisposition, reportFileNameHeader } = await import("../reports/reportFileName");
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
      const { report: built } = await buildSidecarReport(extracted, verified);
      // generator 标记**跟着报告对象走**，不只落在盘上的那份 JSON 里 ——
      // 客户端拿到的响应、服务端渲染的 PDF、派生的下载文件名，
      // 三处都要知道这份报告出自哪条管线。
      const report = { ...built, generator: "mineru" as const };
      console.log(`[mineru-report] report built (${report.chapters.length} chapters, ${report.appendices.length} appendices)`);

      // Persist for /report/last + re-render. The generator tag matters: the
      // SSE/LLM route writes the SAME file, so an unlabelled write let an
      // unverified 111-page draft silently replace a verified MinerU report.
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        // **按任务分目录**（同事 issue #2）——
        // 原来所有任务写**同一个** `reports/last-report.json`：
        // 两个任务并行时，后一个把前一个的顶掉 ✗。
        const own = taskReportFile(taskIdOf(req));
        fs.mkdirSync(path.dirname(own), { recursive: true });
        fs.writeFileSync(own, JSON.stringify(report), "utf-8");
        // 共享的那一份也更新一份 —— 它是「**最近一次**」的便条，
        // 给没带任务 id 的老用法看 ✓（读取时**带 id 的只看自己那一份** ✗）。
        const shared = path.join(path.dirname(REPORT_FILE), "last-report.json");
        try {
          fs.writeFileSync(shared, JSON.stringify(report), "utf-8");
        } catch {
          /* 共享便条写不进去不影响这个任务自己的产物 ✓ */
        }
      } catch (e) {
        console.error("[mineru-report] persist failed:", e);
      }

      if (req.body?.returnPdf) {
        const { renderPdfFromReportV8 } = await import("../reports/htmlRenderV8");
        // finalizePdf was referenced here without ever being imported — the
        // `returnPdf: true` branch would have thrown ReferenceError at runtime.
        const { finalizePdf } = await import("../reports/reportV6");
        const rawPdf = await renderPdfFromReportV8(report);
        // Shared finalization with the CLI: pass-2 TOC page numbers, audit +
        // render gates, PDF metadata, bookmark outline — the customer gets
        // exactly the same artifact quality as the locally-generated report.
        // `writeToDisk: false` —— **不写仓库里的固定路径**：
        // 那是**共享位置**（同事 issue #2：两个任务互相覆盖）。
        const pdf = await finalizePdf(report, rawPdf, { writeToDisk: false });

        // Delivery gate. Without this the endpoint hands over whatever it just
        // built: a report missing its whole parameter matrix, or with the
        // appendix-C table rendered as 73 placeholder cards, was downloadable —
        // and `npm run verify` is only ever run by someone who remembers.
        // A failed gate returns 422 with the reasons instead of the PDF.
        const gate = await runDeliveryGate(report);        if (!gate.ok) {
          console.error("[mineru-report] delivery gate FAILED:", gate.failures);
          return res.status(422).json({
            error: "交付前自检未通过，报告未生成",
            failures: gate.failures,
            hint: "运行 `npm run verify` 查看完整诊断；这些问题会让客户拿到缺内容的报告。",
          });
        }
        console.log(`[mineru-report] delivery gate ok (${gate.checks} checks)`);

        return res.status(200).set({
          "Content-Type": "application/pdf",
          // 文件名**从报告的源文档清单派生**（与另外两条导出路同一处实现），
          // 不再写死 —— 换一套标准后这个名字会骗人。
          "Content-Disposition": contentDisposition(report, "pdf"),
          "X-Report-Filename": reportFileNameHeader(report, "pdf"),
        }).send(pdf);
      }
      return res.json(report);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[mineru-report] failed:", error);
      // 「这套标准尚未配置」**不是服务器故障** —— 是 422（处理不了，但说得清为什么）。
      // 用户要知道的是「先配置案例包」，不是「服务器出错了」。
      const code = String((error as any)?.code ?? "");
      if (code === "case_pack_not_configured") {
        return res.status(422).json({ error: msg, code });
      }
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
          // The exec summary is generated LAST (it may only cite findings the
          // body established) but must render FIRST. Restore reading order:
          // id 0 up front, the rest by ascending id.
          chapters.sort((a, b) => (a.id === 0 ? -1 : b.id === 0 ? 1 : a.id - b.id));
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
            // 这条管线是 LLM 逐章流式生成，**没有经过回源复核**。
            // 标记必须一路带到客户端：客户端把报告原样交给 /report/render，
            // 服务端据此决定文件名与封面要不要打「草稿」标。
            // 少了它，草稿就会用交付件的文件名下载下来（见 reportFileName.ts）。
            generator: "llm-sse",
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
            const dir = path.dirname(REPORT_FILE);
            fs.mkdirSync(dir, { recursive: true });
            // **草稿写它自己的文件**，不覆盖已核验的那一份。
            //
            // 原来两条管线写同一个 `last-report.json`，
            // 于是同事跑一次快速草稿，**交付件就被覆盖了** ——
            // 交付闸门、CLI、官网的「下载 PDF」全都读那一份。
            // 护栏（`?prefer=mineru`）能挡住「读」，挡不住「覆盖」：
            // 已核验的那份**从此就没了**，只能重跑一次 MinerU 才能拿回来。
            //
            // 分开写之后：已核验的那份**永远在**，草稿在隔壁，
            // 要哪份取哪份（`/report/last?prefer=…`）。
            fs.writeFileSync(
              // **按任务分目录** —— 草稿也不许覆盖别的任务的产物 ✗
              taskDraftFile(taskIdOf(req)),
              // Tag the origin so /report/last?prefer=mineru can refuse to serve
              // an unverified LLM draft as if it had been machine-verified.
              JSON.stringify({ ...report, generator: "llm-sse" }),
              "utf-8",
            );
            console.log(`[report] saved last-report.llm-sse.json (generator=llm-sse, ${chapters.length} chapters, ${appendices.length} appendices)`);
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
  router.get("/api/agent/report/last", async (req, res) => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      // **两条管线各写各的文件**：
      //   reports/last-report.json         —— 已核验（MinerU）
      //   reports/last-report.llm-sse.json —— 快速草稿（未经回源复核）
      //
      // 原来两者写同一个文件，草稿会把交付件**覆盖掉** ——
      // 护栏能挡住「读」，挡不住「覆盖」。
      const prefer = typeof req.query?.prefer === "string" ? req.query.prefer : "mineru";
      // **按任务读** —— 同上：带 id 的只看自己那一份 ✓
      const file = resolveReportFile(taskIdOf(req), prefer === "llm-sse" ? "draft" : "report");
      if (!fs.existsSync(file)) {
        return res.status(404).json({
          error:
            prefer === "llm-sse"
              ? "还没有快速草稿（last-report.llm-sse.json 不存在）"
              : "no report generated yet",
          generator: prefer,
          available: fs.existsSync(REPORT_FILE) ? ["mineru"] : [],
        });
      }
      const stat = fs.statSync(file);
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));

      // ?prefer=mineru (default) refuses to hand back an unverified LLM draft
      // dressed up as a verified report.
      const actual = parsed.generator ?? "unknown";
      if (prefer !== actual) {
        return res.status(409).json({
          error: `stored report was generated by '${actual}', not '${prefer}'`,
          generator: actual,
          available: [actual],
          hint: "regenerate via the MinerU pipeline, or call ?prefer=llm-sse to accept the draft",
        });
      }

      // Surface size/mtime so an "empty" response is distinguishable from a
      // missing file — previously this route just 404'd with no clue why.
      res.set("x-report-bytes", String(stat.size));
      res.set("x-report-mtime", stat.mtime.toISOString());
      res.set("x-report-generator", actual);
      res.type("application/json").send(JSON.stringify(parsed));
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
      // 项目根用统一的解析器 —— `../..` 只在源码布局下对
      // （打包后在 dist/ 里，`../..` 会跑到**仓库的上一层**去）。
      const repoRoot = PROJECT_ROOT;
      const reportFile = REPORT_FILE;
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
      const verdictFile = path.join(path.dirname(REPORT_FILE), "verdicts.json");
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
   * POST /api/agent/report/trust/recheck — 让 agent 重跑核验，不依赖人工。
   *
   * 之前这里是 /trust/verdict，把人工在"假差异工作台"点击的结论写进
   * reports/verdicts.json。已废弃，理由有三：
   *   1. 报告每次重新生成，verdicts.json 却不会跟着更新 → 人工结论会套到
   *      新报告上，变成数据污染；
   *   2. 两套真相（报告正文 + 人工标记）会互相打架，且报告重新生成后没人
   *      知道哪条是陈旧的；
   *   3. 核验本可以自动做（trustChecks.ts 一次跑完全部条目），人工只是
   *      把已有结论再点一遍。
   *
   * 现在的做法：工作台只读展示 agent 的判定，用户发现疑点时点「重新核验」
   * → 让 agent 重跑，而不是人逐条裁决。
   */
  router.post("/api/agent/report/trust/recheck", async (_req, res) => {
    const startedAt = Date.now();
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const reportFile = REPORT_FILE;
      if (!fs.existsSync(reportFile)) return res.status(404).json({ error: "no report generated yet" });
      const report = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
      const chapters = report.chapters ?? [];
      // Same two analyses /trust already runs — recheck is a re-run, not a
      // second source of truth.
      const { buildTrustBundle } = await import("../reports/trustChecks");
      const { checkConsistency } = await import("../reports/consistency");
      const bundle = buildTrustBundle(chapters);
      const md = chapters.map((c: { markdown?: string }) => c?.markdown ?? "").join("\n");
      const consistency = checkConsistency(md);
      res.type("application/json").send({
        ok: true,
        elapsedMs: Date.now() - startedAt,
        trust: bundle,
        consistency,
        note: "由 agent 重新核验，无需人工逐条确认。",
      });
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
      // ── 草稿打标 ────────────────────────────────────────────────────
      // 「快速草稿」与交付件走**同一个渲染器、同一套版式**，
      // 渲染出来的东西在 PDF 内部长得一模一样 ——
      // 光靠文件名提示不够：文件一转发就没人记得它的名字了。
      //
      // 所以草稿的**封面标题**也要带上「未经回源复核」，
      // 让任何一页截图都能看出这份不是交付件。
      //
      // 判据与 /report/pdf 的护栏同口径：**证明不了它出自已核验管线，
      // 就不能让它冒充交付件**（没有 generator 标记的也算草稿）。
      const { contentDisposition, reportFileNameHeader, isUnverifiedDraft, DRAFT_MARKER } = await import(
        "../reports/reportFileName"
      );
      let body = req.body;
      if (isUnverifiedDraft(req.body)) {
        const title = String(req.body?.outline?.title ?? "多版本横向对比研究报告");
        body = {
          ...req.body,
          outline: { ...(req.body?.outline ?? {}), title: `${title}${DRAFT_MARKER}` },
        };
        console.warn("[report/render] 渲染的是未经回源复核的草稿 —— 封面与文件名已打标");
      }
      const rawPdf = await renderPdfFromReportV8(body);
      // 文件名同样**从报告的源文档清单派生**（与 /report/pdf 同一处实现），
      // 草稿的名字里带「未经回源复核」标记。
      res
        .status(200)
        .set({
          "Content-Type": "application/pdf",
          "Content-Disposition": contentDisposition(body, "pdf"),
          "X-Report-Filename": reportFileNameHeader(body, "pdf"),
        })
        .send(rawPdf);
    } catch (error) {
      console.error("[report/render]", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "PDF render failed" });
    }
  });
}