import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_TEMPLATE_ID, TEMPLATE_BY_ID, TEMPLATES, type TemplateId } from "@/lib/templates";
import { APP_CONFIG } from "@/lib/config";
import { extractPdfText, normalizeExtractedText } from "@/lib/pdfExtract";
import ReportBuilder from "@/components/ReportBuilder";
import ReviewWorkbench from "@/components/ReviewWorkbench";
import {
  CHANGE_TYPE_LABEL,
  SEVERITY_LABEL,
  SOURCE_LEVEL_LABEL,
  extractJsonBlock,
  stripJsonBlock,
  toFindings,
  type Findings,
} from "@/lib/findings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  FileCheck2,
  FileText,
  FileUp,
  Loader2,
  MoreHorizontal,
  Paperclip,
  PenLine,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Streamdown } from "streamdown";

/* ----------------------------------------------------------------------------
 * 类型定义
 * --------------------------------------------------------------------------*/

type DocStatus = "uploading" | "parsing" | "ready" | "error";

type DocRole = "current" | "draft" | "reference";

type Doc = {
  id: string;
  fileName: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  status: DocStatus;
  role: DocRole;
  pageCount?: number;
  extractedText?: string;
  parseError?: string;
  parsedAt?: number;
  errorMessage?: string;
  localFilePath?: string; // server-side persisted path for the MinerU pipeline
};

type ExtractionStage = {
  id: string;
  fileName: string;
  steps: Array<{ key: Stage; label: string; state: "pending" | "active" | "done" }>;
  progress: number;
};

type Stage = "reading" | "identifying" | "aligning" | "extracting" | "ready";

type StreamRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: StreamRole;
  kind: "welcome" | "text" | "stream" | "result";
  text: string;
  reasoning: string;
  status?: "thinking" | "answering" | "complete" | "error";
  metaHint?: string;
  findings?: Findings;
  /** Complete raw text as accumulated by the SSE consumer. More reliable than
   *  `text` for PDF export because it bypasses any React batching delay. */
  fullText?: string;
};

type ReportPayload = {
  title: string;
  templateName?: string;
  sourceDocuments?: Array<{ name: string; version: string }>;
  content?: string;
  summary?: string;
  changes: Array<{ id: string; title: string; type: string; severity: string; oldText: string; newText: string; impact: string; source: string }>;
  parameters: Array<{ name: string; oldValue: string; newValue: string; unit: string; impact: string; source: string }>;
  evidence: Array<{ title: string; source: string; url?: string; retrievedAt: string }>;
};

/* ----------------------------------------------------------------------------
 * 静态文案：欢迎语 / 建议任务（不是 mock 数据，是产品拷贝）
 * --------------------------------------------------------------------------*/

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  kind: "welcome",
  text: "你好，我是 Regulatory Copilot。\n\n把两份或更多法规文件拖到下方空白处——我会按「结构对齐 → 内容对比 → 专业参数 → 联网证据」四层工作，并把每条结论带上原文锚点和【原文事实 / 模型推断 / 待人工确认】标签，方便你后续审核。",
  reasoning: "",
};

const SUGGESTED_TASKS_FALLBACK = [
  { label: "对比这两份法规的全部结构差异", icon: ScanSearch },
  { label: "抽取所有数值、单位、适用范围与例外条件", icon: PenLine },
  { label: "联网核验草案的官方来源与发布状态", icon: Sparkles },
  { label: "总结会影响产品设计的全部变化", icon: FileCheck2 },
];

const STAGE_FLOW: Array<{ key: Stage; label: string }> = [
  { key: "reading", label: "读取文件" },
  { key: "identifying", label: "识别章节" },
  { key: "aligning", label: "结构对齐" },
  { key: "extracting", label: "抽取参数" },
  { key: "ready", label: "可分析" },
];

/* ----------------------------------------------------------------------------
 * 工具函数
 * --------------------------------------------------------------------------*/

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSseChunk(buffer: { text: string }, line: string) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as { content?: string; reasoning?: string; done?: boolean; error?: string };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * 上传 + 解析（带阶段动画的本地解析）
 * --------------------------------------------------------------------------*/

async function uploadDocument(file: File): Promise<{
  blobUrl: string;
  pageCount?: number;
  extractedText?: string;
  parseError?: string;
  localFilePath?: string;
}> {
  const blobUrl = URL.createObjectURL(file);
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return { blobUrl };
  }

  // 1. Prefer the server: MuPDF.js extraction has no character cap and keeps
  //    page markers, so a 300-page PDF comes back in full.
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/agent/documents", { method: "POST", body: form });
    if (res.ok) {
      const data = (await res.json()) as {
        serverExtractedText?: string;
        serverPageCount?: number;
        parseError?: string;
        localFilePath?: string;
      };
      if (data.serverExtractedText && data.serverExtractedText.length > 0) {
        return {
          blobUrl,
          pageCount: data.serverPageCount,
          extractedText: data.serverExtractedText,
          localFilePath: data.localFilePath,
        };
      }
      // Server reached but returned no text — fall through to the client.
      if (data.parseError) {
        const local = await extractClientPdf(file);
        return { ...local, blobUrl, parseError: local.parseError ?? data.parseError };
      }
    }
  } catch {
    // Server unreachable — use the client extractor below.
  }

  // 2. Client-side fallback (pdfjs-dist), capped so we don't blow the budget.
  const local = await extractClientPdf(file);
  return { ...local, blobUrl };
}

async function extractClientPdf(file: File): Promise<{ pageCount?: number; extractedText?: string; parseError?: string }> {
  try {
    const extraction = await extractPdfText(file, { maxChars: 500_000 });
    return { pageCount: extraction.totalPages, extractedText: extraction.fullText };
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : "PDF 文本提取失败" };
  }
}

async function animateExtraction(
  fileName: string,
  setStage: Dispatch<SetStateAction<ExtractionStage | null>>,
  done: () => void,
) {
  const id = newId();
  const initial: ExtractionStage = {
    id,
    fileName,
    progress: 0,
    steps: STAGE_FLOW.map((s, i) => ({
      key: s.key,
      label: s.label,
      state: i === 0 ? "active" : "pending",
    })),
  };
  setStage(initial);

  for (let i = 0; i < STAGE_FLOW.length; i++) {
    const stage = STAGE_FLOW[i];
    setStage((prev: ExtractionStage | null) =>
      prev && prev.id === id
        ? {
            ...prev,
            progress: Math.round(((i + 0.5) / STAGE_FLOW.length) * 100),
            steps: prev.steps.map((s, idx) => ({
              ...s,
              state: idx < i ? ("done" as const) : idx === i ? ("active" as const) : ("pending" as const),
            })),
          }
        : prev,
    );
    // 模拟不同阶段耗时：抽取参数最慢
    const delay = stage.key === "extracting" ? 900 : stage.key === "aligning" ? 700 : 450;
    await new Promise((r) => setTimeout(r, delay));
  }

  setStage((prev: ExtractionStage | null) =>
    prev && prev.id === id
      ? {
          ...prev,
          progress: 100,
          steps: prev.steps.map((s) => ({ ...s, state: "done" as const })),
        }
      : prev,
  );
  await new Promise((r) => setTimeout(r, 350));
  setStage(null);
  done();
}

/* ----------------------------------------------------------------------------
 * 流式调用 MiniMax
 * --------------------------------------------------------------------------*/

async function streamChat(
  text: string,
  history: ChatMessage[],
  docs: Doc[],
  templateId: TemplateId,
  callbacks: {
    onReasoning: (delta: string) => void;
    onContent: (delta: string) => void;
    /** Called when the SSE stream completes. `fullText` is the complete
     *  answer text accumulated during streaming (including the final chunks
     *  that may not yet be reflected in React state). */
    onDone: (fullText: string) => void;
    onError: (msg: string) => void;
  },
) {
  const template = TEMPLATE_BY_ID[templateId];
  // MiniMax-M3 supports a 1M-token context window, so for three typical
  // 100-page regulatory PDFs (~450K characters total after extraction) we
  // send the full content. If a user piles on a much larger corpus we'd
  // cap proportional shares so nothing gets silently truncated.
  const SOFT_CAP = 1_000_000;
  const totalExtracted = docs.reduce((sum, d) => sum + (d.extractedText?.length ?? 0), 0);
  const docBudgets = docs.map((d) => {
    const len = d.extractedText?.length ?? 0;
    if (totalExtracted <= SOFT_CAP) return len; // everything fits
    return Math.max(30_000, Math.floor((len / totalExtracted) * SOFT_CAP));
  });
  const docSummaries = docs
    .map((d, i) => {
      // 规范化 PDF 提取文本：压缩多份文档叠加产生的连续空行
      const rawText = d.extractedText || "";
      const cleanedText = rawText ? normalizeExtractedText(rawText) : "";
      const budget = Math.min(docBudgets[i], cleanedText.length);
      const excerpt = cleanedText
        ? `\n文本（前 ${budget.toLocaleString()} / ${cleanedText.length.toLocaleString()} 字）：\n${cleanedText.slice(0, budget)}`
        : "";
      return `[文档 ${i + 1}] 文件名：${d.fileName}；大小：${formatBytes(d.size)}${d.pageCount ? `；共 ${d.pageCount} 页` : ""}${d.parseError ? `；解析错误：${d.parseError}` : ""}${excerpt}`;
    })
    .join("\n\n");
  const docContext = docs.length
    ? `\n\n[当前已上传 ${docs.length} 份文件]\n${docSummaries}\n\n请严格基于上述真实文本进行分析${docs.length >= 2 ? "——多文件时按上传顺序识别为 A、B、C 等基线" : ""}。\n\n【强制要求——逐章生成详细数据表格】\n\n请按以下顺序逐章生成对比内容，每章给出真实数据表格（不要只做概括）：\n\n## 章节对比模板（每章必填）\n对每份 PDF 的第 N 章，输出一行表格：\n\n| 章节号 | A（草案）具体内容 | B（2019 版）具体内容 | 差异（新增/修改/删除/无变化） |\n|---|---|---|---|\n\n## 必须覆盖的章节\n1. 远光灯条款（找 "远光灯"、"high beam"、"远光"）\n2. 近光灯条款（找 "近光灯"、"dipped beam"、"近光"）\n3. 前雾灯条款（"前雾灯"、"front fog lamp"）\n4. 转向信号灯条款（"转向"、"direction indicator"、"闪烁频率 Hz"）\n5. 倒车灯条款（"倒车灯"、"reversing lamp"）\n6. 位置灯条款（"位置灯"、"position lamp"）\n7. 制动灯条款（"制动灯"、"stop lamp"、"制动信号"）\n8. 牌照灯条款（"牌照灯"、"rear registration plate"）\n9. 危险警告信号（"危险警告"、"hazard"）\n10. 安装尺寸（"安装高度"、"安装角度"、"尺寸要求"）\n11. 试验条件（"试验电压"、"试验方法"、"环境条件"）\n12. 章节体系（"第 X 章"、"主功能/从属功能/扩展"）\n\n每一条要求包含：\n- 原文摘录（A/B/C 各自的原文片段，至少 20 字）\n- 具体数值（强度 cd、频率 Hz、尺寸 mm/°、时间 s、电压 V 等）\n- 章节号 + 页码（例如 "B 第 22 页"）\n\n【重要】你的回答必须包含两个部分：\n第一部分：按"结构对齐 → 内容对比 →专业参数 → 联网证据"四层组织的详细分析（markdown 格式）。内容对比部分必须包含至少 12 个章节对比表格（按上面的章节清单），每个表格至少 3-5 行数据。\n第二部分：在回答末尾必须输出一个 JSON 代码块（三个反引号包 json 开头，三个反引号结束），包含以下三个数组：\n- changes: 每个变化点包含 id、title、type（added/removed/modified/renumbered）、severity、oldExcerpt、newExcerpt、anchor。至少 20 条。\n- parameters: 每个参数包含 name、oldValue、newValue、unit、source。至少 20 条。\n- evidence: 每条证据包含 title、sourceName、sourceUrl、level。\n\n每条结论必须给出来源页码 / 章节号 / 表号等原文锚点；找不到的内容请使用【待人工确认】前缀。]`
    : `\n\n[当前未上传任何文件。请明确告知需要补充的材料，并按照\"结构对齐 → 内容对比 →专业参数 → 联网证据\"四层承诺交付物。]`;
  const trimmedHistory = history
    .filter((m) => m.role && m.text && m.id !== "welcome")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.text }));
  const messages = [
    { role: "system" as const, content: `[模板：${template.name}] ${template.systemPrompt}` },
    ...trimmedHistory,
    { role: "user" as const, content: `【核心要求——客户需求】对三份法规（GB 4785 草案 V4.3.5 vs GB 4785-2019 现行版 vs UN R48 欧洲标准）进行多版本横向对比，必须输出**至少 20 页**的内容充实的 PDF。最终交付物必须包含：\n\n1. **结构对齐**（三份文档章节体系对比，1-2 页表格）\n2. **内容对比**（逐章节列出新增/修改/删除的条款，每条都有原文摘录 + 章节号 + 页码，必须有 12+ 个章节对比表格，至少 30 条 changes）\n3. **专业参数**（远光/近光/转向/制动/位置/倒车/危险警告/牌照等每种灯具的数值参数对比，至少 25 条 parameters）\n4. **联网证据**（至少 5 条 evidence）\n5. **变化点总结**（最关键的 10 条 change，附原文摘录）\n\n**禁止**：写到一半就停止输出、说"对比完成"等结束语后停止。每个章节必须输出完整原文摘录和具体数值。${docContext}` },
  ];
  try {
    const response = await fetch("/api/agent/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Accumulate the final text inside the loop so we have the complete
    // answer ready by the time we call onDone — React state updates from
    // onContent are async and could still be in flight when the user clicks
    // the "下载 PDF" button.
    let accumulatedText = "";
    let contentChunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseSseChunk({ text: "" }, line + "\n");
        if (!event) continue;
        if (event.error) throw new Error(event.error);
        if (event.reasoning) callbacks.onReasoning(event.reasoning);
        if (event.content) {
          accumulatedText += event.content;
          contentChunkCount += 1;
          callbacks.onContent(event.content);
        }
        if (event.done) {
          callbacks.onDone(accumulatedText);
          return;
        }
      }
    }
    console.log("[streamChat] stream ended. contentChunkCount:", contentChunkCount, "accumulatedText.length:", accumulatedText.length);
    callbacks.onDone(accumulatedText);
  } catch (error) {
    console.error("[streamChat] ERROR:", error);
    callbacks.onError(error instanceof Error ? error.message : "MiniMax 流式服务暂不可用，请检查环境配置");
  }
}

/* ----------------------------------------------------------------------------
 * 主组件
 * --------------------------------------------------------------------------*/

export type ViewId =
  | "compare"
  | "projects"
  | "documents"
  | "review"
  | "research"
  | "reports"
  | "settings";

export default function Home({ defaultView }: { defaultView?: ViewId }) {
  const [templateId, setTemplateId] = useState<TemplateId>(DEFAULT_TEMPLATE_ID);
  const template = TEMPLATE_BY_ID[templateId];
  const [messages, setMessages] = useState<ChatMessage[]>([
    { ...WELCOME, text: WELCOME.text.replace("[模板]", template.name) },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [extracting, setExtracting] = useState<ExtractionStage | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  const activeDoc = useMemo(() => docs.find((d) => d.id === activeDocId) ?? docs[0] ?? null, [docs, activeDocId]);

  // Navigation view state
  const [currentView, setCurrentView] = useState<ViewId>(defaultView ?? "compare");

  // Multi-chapter report builder (Regex + streaming LLM + HTML→PDF)
  const [showReportBuilder, setShowReportBuilder] = useState(false);

  // Settings state
  const [settings, setSettings] = useState({ temperature: 0.15, model: "MiniMax-M3", defaultTemplate: DEFAULT_TEMPLATE_ID, maxFileSizeMB: 100 });

  // Conversation persistence to localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("rc-conversation");
      if (saved) {
        const data = JSON.parse(saved);
        if (data.messages?.length > 1) {
          setMessages(data.messages);
          if (data.templateId) setTemplateId(data.templateId);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (messages.length > 1) {
      const timer = setTimeout(() => {
        try { localStorage.setItem("rc-conversation", JSON.stringify({ messages, templateId })); } catch {}
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [messages, templateId]);

  // 滚到对话底部（消息新增 + 文本流式追加都要触发）
  useEffect(() => {
    const el = conversationRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 全局：始终把页面滚到主内容区（避免 composer 蒙层挡到对话底部）
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [templateId]);

  // 文档上传
  const handleFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const MAX_FILE_SIZE = settings.maxFileSizeMB * 1024 * 1024;
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`${file.name} 超过 ${settings.maxFileSizeMB}MB 限制（当前 ${formatBytes(file.size)}）`);
        continue;
      }
      const id = newId();
      const doc: Doc = {
        id,
        fileName: file.name,
        size: file.size,
        mimeType: file.type || "application/pdf",
        blobUrl: "",
        status: "uploading",
        role: docs.length === 0 ? "current" : "draft",
      };
      setDocs((prev) => [...prev, doc]);

      const { blobUrl, pageCount, extractedText, parseError, localFilePath } = await uploadDocument(file);
      setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, blobUrl, status: "parsing" } : d)));

      await animateExtraction(file.name, setExtracting, () => {
        setDocs((prev) => {
          const next = prev.map((d) =>
            d.id === id
              ? {
                  ...d,
                  status: "ready",
                  pageCount,
                  extractedText,
                  parseError,
                  parsedAt: Date.now(),
                  localFilePath,
                }
              : d,
          );
          return next;
        });
        setActiveDocId(id);
        if (parseError) toast.error(`${file.name} 文本提取失败：${parseError}`);
        else if (!extractedText) toast(`${file.name} 已上传（仅预览，未提取文本）`);
        else toast.success(`${file.name} 已就绪，可开始分析`);
      });
    }
  }, []);

  // 拖拽
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type === "application/pdf" || /\.(pdf|docx?)$/i.test(f.name));
      if (!files.length) {
        toast.error("仅支持 PDF / Word 文档");
        return;
      }
      void handleFiles(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFiles]);

  // 发送
  const submit = useCallback(
    async (value?: string) => {
      const text = (value ?? input).trim();
      if (!text || running) return;
      const userMsg: ChatMessage = { id: newId(), role: "user", kind: "text", text, reasoning: "" };
      const assistantId = newId();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", kind: "stream", text: "", reasoning: "", status: "thinking" },
      ]);
      setInput("");
      setRunning(true);
      const history = [...messages, userMsg];
      const t0 = Date.now();
      await streamChat(text, history, docs, templateId, {
        onReasoning: (delta) =>
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const status: ChatMessage["status"] = m.status === "complete" ? "complete" : "thinking";
              return {
                ...m,
                reasoning: m.reasoning + delta,
                status,
                metaHint: Date.now() - t0 > 8000 ? "模型在长上下文上思考" : "",
              };
            }),
          ),
        onContent: (delta) =>
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const status: ChatMessage["status"] = m.status === "complete" ? "complete" : "answering";
              return { ...m, text: m.text + delta, status };
            }),
          ),
        onDone: (fullText) => {
          // Stash the full text in a ref synchronously — the React state
          // batch that follows may not have settled by the time the user
          // clicks the "下载 PDF" button.
          fullTextRef.current[assistantId] = fullText || "";
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const finalText = fullText || m.text;
              const rawJson = extractJsonBlock(finalText);
              const findings = toFindings(rawJson);
              return { ...m, text: finalText, fullText: finalText, status: "complete", findings };
            }),
          );
        },
        onError: (msg) => {
          toast.error(msg);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, status: "error", text: m.text || msg } : m)),
          );
        },
      });
      setRunning(false);
    },
    [docs, input, messages, running, templateId],
  );

  // 把一条 assistant 回答组装成报告 payload（正文 + 结构化 findings）
  const buildReportPayload = useCallback(
    (msg: ChatMessage): ReportPayload | null => {
      // Prefer the stream-completed fullText captured in the ref (most
      // reliable), then the message's fullText field, then m.text.
      const text =
        fullTextRef.current[msg.id] || msg.fullText || msg.text;
      console.log("[PDF] buildReportPayload: refText=", fullTextRef.current[msg.id]?.length, "msgFullText=", msg.fullText?.length, "msgText=", msg.text?.length);
      if (!text) return null;
      const findings = msg.findings ?? toFindings(extractJsonBlock(text));
      // 传给 PDF 的 markdown：保留 ````json ... ``` 已被 stripJsonBlock 剥离，
      // 但要保留标题、表格、列表的原始格式（只压缩连续空行，不重写）。
      const prose = text.replace(/```(?:json)?[\s\S]*?```/gi, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
      return {
        title: `${template.name} · 法规对比报告`,
        templateName: template.name,
        sourceDocuments: docs.map((d) => ({ name: d.fileName, version: d.pageCount ? `${d.pageCount} 页` : "" })),
        content: prose,
        summary: prose.slice(0, 1000),
        changes: findings.changes.map((c) => ({
          id: c.id,
          title: c.title,
          type: CHANGE_TYPE_LABEL[c.type] ?? c.type,
          severity: SEVERITY_LABEL[c.severity] ?? c.severity,
          oldText: c.oldExcerpt ?? "",
          newText: c.newExcerpt ?? "",
          impact: c.productImpact ?? "",
          source: c.anchor ?? "",
        })),
        parameters: findings.parameters.map((p) => ({
          name: p.name,
          oldValue: String(p.oldValue ?? "—"),
          newValue: String(p.newValue ?? "—"),
          unit: p.unit ?? "",
          impact: p.impact ? SEVERITY_LABEL[p.impact] : "",
          source: p.source ?? "",
        })),
        evidence: findings.evidence.map((e) => ({
          title: e.title,
          source: `${SOURCE_LEVEL_LABEL[e.level]} · ${e.source}`,
          url: e.url,
          retrievedAt: e.retrievedAt,
        })),
      };
    },
    [docs, template.name],
  );

  // 下载报告（PDF / Word）
  const downloadReport = useCallback(
    async (payload: ReportPayload, format: "word" | "pdf") => {
      try {
        const response = await fetch(`/api/agent/report/${format}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = format === "word" ? "法规对比报告.doc" : "法规对比报告.pdf";
        link.click();
        URL.revokeObjectURL(url);
        toast.success(`${format.toUpperCase()} 报告已下载`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "报告生成失败");
      }
    },
    [],
  );

  // Latest full text per assistant message id — written by onDone, read by the
  // download button. Avoids the React state batching window where m.text is
  // still lagging behind the stream.
  const fullTextRef = useRef<Record<string, string>>({});

  // 报告导出（导出最近一条回答）
  const exportReport = useCallback(
    async (format: "word" | "pdf") => {
      // PDF exports the full regulatory comparison report (V8 pipeline:
      // 139 pages, triptych cards, closure dashboard), NOT the chat answer.
      // The server reads reports/last-report.json and renders it through
      // htmlRenderV8 — byte-identical to POST /api/agent/report/render.
      if (format === "pdf") {
        try {
          const response = await fetch("/api/agent/report/pdf", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ useV8: true }),
          });
          if (response.status === 409) {
            const detail = await response.json().catch(() => null);
            toast.error(detail?.error ?? "尚未生成对比报告，请先生成完整报告");
            return;
          }
          if (!response.ok) throw new Error(await response.text());
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "GB4785_多版本横向对比研究报告.pdf";
          link.click();
          URL.revokeObjectURL(url);
          toast.success("对比报告 PDF 已下载（完整多版本横评）");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "报告生成失败");
        }
        return;
      }

      // Word still exports the latest chat answer (export.ts renderer).
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text);
      // Prefer the synchronously-captured full text (set at onDone) so we
      // don't read a half-rendered m.text if the user clicks immediately.
      const fallbackText = lastAssistant ? fullTextRef.current[lastAssistant.id] : undefined;
      if (!lastAssistant) {
        toast.error("暂无可导出的分析结果");
        return;
      }
      // Use the most-complete text available: ref > message.fullText > message.text
      const enriched: ChatMessage = fallbackText
        ? { ...lastAssistant, text: fallbackText, fullText: fallbackText }
        : lastAssistant;
      const payload = buildReportPayload(enriched);
      if (!payload) {
        toast.error("暂无可导出的分析结果");
        return;
      }
      await downloadReport(payload, format);
    },
    [buildReportPayload, downloadReport, messages],
  );

  const removeDoc = (id: string) => {
    setDocs((prev) => {
      const target = prev.find((d) => d.id === id);
      if (target?.blobUrl) URL.revokeObjectURL(target.blobUrl);
      const next = prev.filter((d) => d.id !== id);
      if (activeDocId === id) setActiveDocId(next[0]?.id ?? null);
      return next;
    });
  };

  return (
    <div
      className={`relative min-h-screen text-[#0c1a2b] ${dragActive ? "ring-4 ring-inset ring-[#a17334]/30" : ""}`}
      style={{
        backgroundColor: "#faf6ec",
        backgroundImage:
          "radial-gradient(circle at 18% 12%, rgba(161,115,52,0.06), transparent 38%), radial-gradient(circle at 82% 88%, rgba(12,26,43,0.05), transparent 42%)",
      }}
    >
      <PageHeader
        onExport={exportReport}
        templateId={templateId}
        onTemplateChange={setTemplateId}
        disabled={!messages.some((m) => m.role === "assistant" && m.text)}
      />
      <main className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 pb-44 pt-8 md:px-8 md:pt-10">
        {currentView === "settings" ? (
          <SettingsPanel settings={settings} onSettingsChange={setSettings} />
        ) : currentView === "review" ? (
          <ReviewWorkbench />
        ) : currentView === "projects" || currentView === "documents" || currentView === "research" || currentView === "reports" ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border bg-white py-20" style={{ borderColor: "#e6dfd0" }}>
            <FolderOpen className="h-12 w-12 text-[#9c8b6c]" />
            <p className="mt-4 text-lg font-semibold" style={{ fontFamily: '"Noto Serif SC", serif' }}>
              {currentView === "projects" ? "我的项目" : currentView === "documents" ? "资料与引用" : currentView === "research" ? "联网研究" : "报告中心"}
            </p>
            <p className="mt-2 text-sm text-[#7c6a4f]">该功能即将上线</p>
          </div>
        ) : (
          <>
            <DocStrip docs={docs} activeId={activeDocId} onSelect={setActiveDocId} onRemove={removeDoc} onAdd={handleFiles} />

            {/* Full report builder entry */}
            {!showReportBuilder && (
              <div className="flex items-center justify-between rounded-xl border bg-white px-4 py-3" style={{ borderColor: "#e6dfd0" }}>
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#fdf3df] text-[#a17334]">
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-[13px] font-medium text-[#0c1a2b]">完整对比报告（20+ 页 PDF）</p>
                    <p className="text-[11px] text-[#7c6a4f]">Regex 提取 + 动态 13 章 + 逐章流式生成 + 专业排版，约 15-20 分钟</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowReportBuilder(true)}
                  disabled={docs.filter((d) => d.extractedText).length < 2}
                  className="flex items-center gap-1.5 rounded-md bg-[#0c1a2b] px-4 py-2 text-xs font-medium text-[#faf6ec] transition hover:bg-[#1a2f4a] disabled:cursor-not-allowed disabled:bg-[#d8cfb8]"
                >
                  <Sparkles className="h-3.5 w-3.5" /> 生成完整报告
                </button>
              </div>
            )}

            {showReportBuilder ? (
              <ReportBuilder docs={docs} onClose={() => setShowReportBuilder(false)} />
            ) : (
              <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] xl:[&>*:nth-child(2)]:border-l xl:[&>*:nth-child(2)]:border-[#d8cfb8] xl:[&>*:nth-child(2)]:pl-6">
                <PDFViewer doc={activeDoc} extracting={extracting} onDropFiles={handleFiles} dragActive={dragActive} />
                <Conversation
                  messages={messages}
                  extracting={extracting}
                  ref={conversationRef}
                  onSuggest={(text) => submit(text)}
                  onDownloadPdf={(msg) => {
                    // Use the full text from the ref if available (it holds the
                    // complete SSE-accumulated answer even if React state hasn't
                    // caught up yet).
                    const refText = fullTextRef.current[msg.id];
                    const enriched: ChatMessage = refText
                      ? { ...msg, text: refText, fullText: refText }
                      : msg;
                    const payload = buildReportPayload(enriched);
                    if (payload) void downloadReport(payload, "pdf");
                    else toast.error("暂无可导出的分析结果");
                  }}
                  suggestedTasks={template.suggestedTasks}
                />
              </div>
            )}
          </>
        )}
      </main>

      <Composer
        ref={composerRef}
        value={input}
        onChange={setInput}
        onSubmit={() => submit()}
        onAttach={() => composerRef.current?.focus()}
        running={running}
      />

      {dragActive && <DropOverlay />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 子组件
 * --------------------------------------------------------------------------*/

function PageHeader({
  onExport,
  templateId,
  onTemplateChange,
  disabled,
}: {
  onExport: (f: "word" | "pdf") => void;
  templateId: TemplateId;
  onTemplateChange: (id: TemplateId) => void;
  disabled: boolean;
}) {
  return (
    <header
      className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b px-5 backdrop-blur md:px-10"
      style={{ borderColor: "#e6dfd0", backgroundColor: "rgba(250,246,236,0.85)" }}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#0c1a2b] text-[#faf6ec]">
          <PenLine className="h-4 w-4" />
        </div>
        <div>
          <p
            className="text-[15px] font-semibold leading-tight tracking-tight text-[#0c1a2b]"
            style={{ fontFamily: '"Noto Serif SC", "Source Serif Pro", serif' }}
          >
            Regulatory Copilot
          </p>
          <p className="mt-0.5 text-[11px] text-[#7c6a4f]">结构对齐 · 内容对比 · 专业参数 · 联网证据</p>
        </div>
      </div>

      <TemplateBar activeId={templateId} onChange={onTemplateChange} />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onExport("word")}
          className="h-9 rounded-md border-[#d8cfb8] bg-white/70 px-3 text-xs text-[#3a3027] hover:bg-white"
        >
          <Download className="mr-1.5 h-3.5 w-3.5" /> Word
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onExport("pdf")}
          className="h-9 rounded-md border-[#d8cfb8] bg-white/70 px-3 text-xs text-[#3a3027] hover:bg-white"
        >
          <Download className="mr-1.5 h-3.5 w-3.5" /> PDF
        </Button>
        <button className="ml-1 rounded-md p-2 text-[#7c6a4f] hover:bg-white" aria-label="更多">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

function DocStrip({
  docs,
  activeId,
  onSelect,
  onRemove,
  onAdd,
}: {
  docs: Doc[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (files: File[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-xl border bg-white/60 p-3" style={{ borderColor: "#e6dfd0" }}>
      <span
        className="mr-1 text-[11px] uppercase tracking-[0.18em] text-[#9c8b6c]"
        style={{ fontFamily: '"Noto Serif SC", serif' }}
      >
        Documents
      </span>
      <span className="text-[10px] text-[#9c8b6c]">· {docs.length} 份已上传</span>
      {docs.map((d) => {
        const isActive = d.id === activeId;
        const charCount = d.extractedText?.length ?? 0;
        const charSuffix =
          charCount >= 1000 ? `${(charCount / 1000).toFixed(0)}k 字` : charCount > 0 ? `${charCount} 字` : "";
        return (
          <div
            key={d.id}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
              isActive ? "border-[#0c1a2b] bg-[#0c1a2b] text-[#faf6ec]" : "border-[#d8cfb8] bg-white text-[#3a3027] hover:border-[#a17334]"
            }`}
            onClick={() => onSelect(d.id)}
            title={charCount > 0 ? `已抽取 ${charCount.toLocaleString()} 字${d.pageCount ? ` / ${d.pageCount} 页` : ""}` : "等待抽取"}
          >
            <FileText className="h-3.5 w-3.5 opacity-80" />
            <span className="max-w-[160px] truncate font-medium">{d.fileName}</span>
            <span className={`text-[10px] ${isActive ? "text-[#d8cfb8]" : "text-[#9c8b6c]"}`}>{formatBytes(d.size)}</span>
            {d.status === "ready" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-[#5e8b66]" />
            ) : d.status === "error" ? (
              <CircleAlert className="h-3.5 w-3.5 text-[#a23030]" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#a17334]" />
            )}
            {charSuffix && (
              <span className={`text-[10px] tabular-nums ${isActive ? "text-[#d8cfb8]" : "text-[#5e8b66]"}`}>{charSuffix}</span>
            )}
            {d.blobUrl && d.status === "ready" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const a = document.createElement("a");
                  a.href = d.blobUrl;
                  a.download = d.fileName;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                }}
                className={`opacity-0 transition group-hover:opacity-100 ${isActive ? "text-[#d8cfb8] hover:text-white" : "text-[#7c6a4f] hover:text-[#0c1a2b]"}`}
                aria-label="下载"
                title="下载原文件"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            {d.status === "error" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(d.id);
                  toast.info("请重新拖拽文件上传");
                }}
                className={`opacity-0 transition group-hover:opacity-100 ${isActive ? "text-[#d8cfb8]" : "text-[#a17334]"}`}
                aria-label="重试"
                title="重新上传"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(d.id);
              }}
              className={`ml-1 opacity-0 transition group-hover:opacity-100 ${isActive ? "text-[#d8cfb8] hover:text-white" : "text-[#9c8b6c] hover:text-[#a23030]"}`}
              aria-label="移除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#d8cfb8] bg-white px-3 py-1.5 text-xs text-[#7c6a4f] transition hover:border-[#a17334] hover:bg-[#fdf3df] hover:text-[#0c1a2b]"
      >
        <FileUp className="h-3.5 w-3.5" /> 添加法规
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,application/pdf"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onAdd(files);
          e.target.value = "";
        }}
      />
    </section>
  );
}

function PDFViewer({
  doc,
  extracting,
  onDropFiles,
  dragActive,
}: {
  doc: Doc | null;
  extracting: ExtractionStage | null;
  onDropFiles: (files: File[]) => void;
  dragActive: boolean;
}) {
  return (
    <section
      className="relative flex min-h-[640px] flex-col overflow-hidden rounded-2xl border bg-white"
      style={{ borderColor: "#e6dfd0", boxShadow: "0 1px 0 rgba(12,26,43,0.04), 0 18px 36px -28px rgba(12,26,43,0.18)" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) onDropFiles(files);
      }}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "#ece4d1" }}>
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-[#7c6a4f]" />
          <p
            className="text-[13px] font-semibold text-[#0c1a2b]"
            style={{ fontFamily: '"Noto Serif SC", serif' }}
          >
            {doc?.fileName ?? "尚未选择文件"}
          </p>
          {doc && (
            <Badge
              variant="outline"
              className="ml-2 border-[#d8cfb8] bg-[#faf6ec] text-[10px] font-normal text-[#7c6a4f]"
            >
              {doc.status === "ready" ? "已就绪" : doc.status === "parsing" ? "解析中" : doc.status === "uploading" ? "上传中" : "错误"}
            </Badge>
          )}
          {doc?.extractedText && (
            <span className="ml-2 text-[10px] text-[#9c8b6c]">已抽取 {doc.extractedText.length.toLocaleString()} 字</span>
          )}
        </div>
        {doc && (
          <p className="text-[10px] text-[#9c8b6c]">{doc.pageCount ? `${doc.pageCount} 页` : formatBytes(doc.size)}</p>
        )}
      </div>

      {extracting ? (
        <ExtractionProgress stage={extracting} />
      ) : doc?.blobUrl ? (
        <iframe key={doc.id} src={`${doc.blobUrl}#zoom=FitH`} className="h-[640px] w-full flex-1 bg-[#f4ecd8]" title={doc.fileName} />
      ) : (
        <EmptyDropZone highlight={dragActive} onFiles={onDropFiles} />
      )}
    </section>
  );
}

function EmptyDropZone({ highlight, onFiles }: { highlight: boolean; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <div
        className={`flex h-28 w-28 items-center justify-center rounded-full border-2 border-dashed transition ${
          highlight ? "scale-105 border-[#a17334] bg-[#fdf3df]" : "border-[#d8cfb8] bg-[#faf6ec]"
        }`}
      >
        <FileUp className={`h-10 w-10 ${highlight ? "text-[#a17334]" : "text-[#9c8b6c]"}`} />
      </div>
      <div className="space-y-1.5">
        <p
          className="text-lg font-semibold text-[#0c1a2b]"
          style={{ fontFamily: '"Noto Serif SC", serif' }}
        >
          {highlight ? "松开以导入" : "把 PDF / Word 拖到这里"}
        </p>
        <p className="text-xs text-[#7c6a4f]">
          支持 .pdf · .doc · .docx，单次最多 8 个文件；本地解析后即可向右侧 Copilot 提问。
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,application/pdf"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
      <Button
        onClick={() => inputRef.current?.click()}
        className="h-10 rounded-md bg-[#0c1a2b] px-4 text-xs font-medium text-[#faf6ec] hover:bg-[#0c1a2b]/90"
      >
        <Paperclip className="mr-1.5 h-3.5 w-3.5" />
        浏览文件
      </Button>
    </div>
  );
}

function ExtractionProgress({ stage }: { stage: ExtractionStage }) {
  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-[#a17334]" />
        <div>
          <p
            className="text-[15px] font-semibold text-[#0c1a2b]"
            style={{ fontFamily: '"Noto Serif SC", serif' }}
          >
            正在提取 {stage.fileName}
          </p>
          <p className="mt-0.5 text-xs text-[#7c6a4f]">本地解析 · 全程在你的浏览器内完成</p>
        </div>
      </div>
      <div className="space-y-3">
        {stage.steps.map((s) => (
          <div key={s.key} className="flex items-center gap-3 text-sm">
            {s.state === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-[#5e8b66]" />
            ) : s.state === "active" ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#a17334]" />
            ) : (
              <span className="h-4 w-4 rounded-full border border-[#d8cfb8]" />
            )}
            <span
              className={
                s.state === "done"
                  ? "text-[#3a3027] line-through decoration-[#d8cfb8]"
                  : s.state === "active"
                  ? "font-medium text-[#0c1a2b]"
                  : "text-[#9c8b6c]"
              }
              style={{ fontFamily: s.state === "active" ? '"Noto Serif SC", serif' : undefined }}
            >
              {s.label}
            </span>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] text-[#7c6a4f]">
          <span>提取中</span>
          <span>{stage.progress}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[#f0e7d0]">
          <div
            className="h-full bg-[#a17334] transition-all"
            style={{ width: `${stage.progress}%`, transitionDuration: "300ms" }}
          />
        </div>
      </div>
    </div>
  );
}

function Conversation({
  messages,
  extracting,
  ref,
  onSuggest,
  onDownloadPdf,
  suggestedTasks,
}: {
  messages: ChatMessage[];
  extracting: ExtractionStage | null;
  ref: React.RefObject<HTMLDivElement | null>;
  onSuggest: (text: string) => void;
  onDownloadPdf?: (message: ChatMessage) => void;
  suggestedTasks: Array<{ label: string; icon: typeof Sparkles }>;
}) {
  return (
    <section
      className="flex max-h-[640px] min-h-[520px] flex-col overflow-hidden rounded-2xl border bg-white"
      style={{ borderColor: "#e6dfd0", boxShadow: "0 1px 0 rgba(12,26,43,0.04), 0 18px 36px -28px rgba(12,26,43,0.18)" }}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "#ece4d1" }}>
        <div className="flex items-center gap-2">
          <PenLine className="h-4 w-4 text-[#7c6a4f]" />
          <p
            className="text-[13px] font-semibold text-[#0c1a2b]"
            style={{ fontFamily: '"Noto Serif SC", serif' }}
          >
            对话 · Copilot
          </p>
        </div>
        <p className="text-[10px] text-[#9c8b6c]">MiniMax-M3 · 流式</p>
      </div>

      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="space-y-6">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onSubmit={onSuggest} onDownloadPdf={onDownloadPdf} />
          ))}
          {extracting && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-[#d8cfb8] bg-[#fdf3df]/60 px-3 py-2 text-xs text-[#7c6a4f]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#a17334]" />
              正在提取 <span className="font-medium text-[#0c1a2b]">{extracting.fileName}</span>，稍候即可提问
            </div>
          )}
        </div>
      </div>

      {messages.length <= 1 && !extracting && (
        <div className="border-t px-5 py-3" style={{ borderColor: "#ece4d1" }}>
          <div className="flex flex-wrap gap-2">
            {suggestedTasks.map((task) => (
              <button
                key={task.label}
                onClick={() => onSuggest(task.label)}
                className="flex items-center gap-1.5 rounded-full border border-[#d8cfb8] bg-[#faf6ec] px-3 py-1.5 text-[11px] text-[#3a3027] transition hover:border-[#a17334] hover:bg-white"
              >
                <task.icon className="h-3.5 w-3.5 text-[#a17334]" />
                {task.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  onSubmit,
  onDownloadPdf,
}: {
  message: ChatMessage;
  onSubmit?: (text: string) => void;
  onDownloadPdf?: (message: ChatMessage) => void;
}) {
  const isUser = message.role === "user";
  const showThinking = message.role === "assistant" && message.status === "thinking" && !message.text;
  // 欢迎语（kind === "welcome"）没有分析价值，不提供下载入口
  const canDownloadPdf =
    !isUser && message.kind !== "welcome" && Boolean(message.text) && Boolean(onDownloadPdf);
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#0c1a2b] text-[#faf6ec]">
          <PenLine className="h-3.5 w-3.5" />
        </div>
      )}
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-3 text-[13.5px] leading-7 ${
          isUser
            ? "rounded-tr-md bg-[#0c1a2b] text-[#faf6ec]"
            : "rounded-tl-md border border-[#ece4d1] bg-white text-[#1c2733]"
        }`}
        style={!isUser ? { fontFamily: '"Noto Sans SC", "PingFang SC", system-ui, sans-serif' } : undefined}
      >
        {showThinking ? (
          <div className="flex items-center gap-2 text-[#7c6a4f]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#a17334]" />
            <span style={{ fontFamily: '"Noto Serif SC", serif' }}>Copilot 正在分析…</span>
          </div>
        ) : isUser ? (
          <p className="whitespace-pre-line">{message.text}</p>
        ) : (
          <>
            <div className="rc-prose">
              <AnnotatedStreamdown text={stripJsonBlock(message.text)} reasoning={message.reasoning} status={message.status} />
            </div>
            {message.findings && (
              <FindingsCards
                findings={message.findings}
                rawJson={extractJsonBlock(message.text)
                  ? message.text.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim()
                  : undefined}
                onAskFollowUp={onSubmit}
              />
            )}
            {canDownloadPdf && (
              <div className="mt-2 flex justify-end">
                <button
                  onClick={() => onDownloadPdf?.(message)}
                  className="flex items-center gap-1 rounded-md border border-[#d8cfb8] px-2 py-0.5 text-[10px] text-[#7c6a4f] transition hover:border-[#a17334] hover:bg-[#fdf3df] hover:text-[#8a5c1a]"
                  aria-label="下载 PDF"
                  title="把这条回答下载为 PDF"
                >
                  <Download className="h-3 w-3" /> 下载 PDF
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AnnotatedStreamdown({
  text,
  reasoning,
  status,
}: {
  text: string;
  reasoning: string;
  status?: ChatMessage["status"];
}) {
  // 预处理：在特殊标记外层加 span 染色，再交回 Streamdown。
  const decorated = useMemo(() => decorateStreamText(text), [text]);
  const [showReasoning, setShowReasoning] = useState(false);
  const isStreaming = status === "thinking" || status === "answering";
  const hasReasoning = reasoning.length > 0 || isStreaming;

  // Keep a copy of the raw markdown so the PDF download gets the full source
  // text, not whatever streamdown has rendered so far. Streamdown can lag
  // behind the stream, especially during long answers, and reading its DOM
  // output for the PDF would silently drop the last ~30% of the answer.
  if (typeof window !== "undefined") {
    (window as unknown as { __annotatedStreamText?: string }).__annotatedStreamText = text;
  }
  return (
    <div className="space-y-2">
      {hasReasoning && (
        <button
          onClick={() => setShowReasoning((v) => !v)}
          className="flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-[#9c8b6c] hover:text-[#a17334]"
        >
          {showReasoning ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          思考过程 · {reasoning.length || "…"} 字
        </button>
      )}
      {showReasoning && (
        <pre
          className="max-h-40 overflow-auto rounded-md border border-dashed border-[#d8cfb8] bg-[#faf6ec] p-3 text-[11px] leading-5 text-[#5e5240]"
          style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
        >
          {reasoning || "正在等待模型思维链路…"}
        </pre>
      )}
      <div className="whitespace-pre-line">
        {decorated ? (
          <Streamdown>{decorated}</Streamdown>
        ) : isStreaming ? (
          <span className="inline-flex items-center gap-1 text-[#7c6a4f]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a17334]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a17334]" style={{ animationDelay: "120ms" }} />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a17334]" style={{ animationDelay: "240ms" }} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * MiniMax-M3 经常在段间连打多个 `\n`，Streamdown 渲染后产生大量空白段落
 * （实测表格上方出现 5+ 空行）。这里彻底消灭空行——聊天区不允许空白：
 *   - 连续换行 → 单个换行（`\n`）
 *   - GFM 表格不需要空行终止（遇到非 `|` 行即结束），单换行是安全的
 *   - 代码块（``` fence）先被占位保护，避免内部换行被压掉
 */
function compactMarkdownWhitespace(text: string): string {
  if (!text) return text;
  // 保护 fenced code 块
  const blocks: string[] = [];
  const masked = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `~~CODEBLOCK${blocks.length - 1}~~`;
  });
  const collapsed = masked
    // 行尾空白
    .replace(/[ \t]+\n/g, "\n")
    // 任意连续换行 → 单个换行（彻底消灭空白段落）
    .replace(/(\n\s*){2,}/g, "\n")
    // 行内多余空格
    .replace(/[ \t]{2,}/g, " ")
    // 去除首尾空白
    .trim();
  // 还原代码块
  return collapsed.replace(/~~CODEBLOCK(\d+)~~/g, (m, i) => blocks[Number(i)] ?? m);
}

/**
 * 与 compactMarkdownWhitespace 相同的保证：任何残留的连续换行压到单个。
 */
function nukeBlankLines(text: string): string {
  if (!text) return text;
  return text.replace(/(\r?\n){2,}/g, "\n");
}

function decorateStreamText(text: string): string {
  if (!text) return text;
  return nukeBlankLines(compactMarkdownWhitespace(text))
    .replace(/【原文事实】/g, '<span class="inline-flex items-center rounded-full bg-[#fde0e0] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[#a23030]">原文事实</span> ')
    .replace(/【模型推断】/g, '<span class="inline-flex items-center rounded-full bg-[#fdf3df] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[#a17334]">模型推断</span> ')
    .replace(/【待人工确认】/g, '<span class="inline-flex items-center rounded-full bg-[#ece4d1] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[#3a3027]">待人工确认</span> ');
}

const Composer = ({
  ref,
  value,
  onChange,
  onSubmit,
  onAttach,
  running,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onAttach: () => void;
  running: boolean;
}) => (
  <div
    className="fixed bottom-0 left-0 right-0 lg:left-[276px] z-20 pb-6 pt-12"
    style={{
      background: "linear-gradient(to top, #faf6ec 35%, rgba(250,246,236,0))",
    }}
  >
    <div className="mx-auto max-w-[1500px] px-5 md:px-8">
      <div
        className="overflow-hidden rounded-2xl border bg-white"
        style={{
          borderColor: "#d8cfb8",
          boxShadow: "0 12px 32px -18px rgba(12,26,43,0.25), 0 2px 0 rgba(12,26,43,0.04)",
        }}
      >
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="向 Copilot 提问：例如「抽取 §5.3 的安装参数差异」「草案相比现行版新增加了哪些章节」"
          className="min-h-[72px] resize-none border-0 px-4 pb-1 pt-3 text-sm shadow-none focus-visible:ring-0"
          style={{ fontFamily: '"Noto Sans SC", system-ui, sans-serif' }}
        />
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-1 text-[11px] text-[#7c6a4f]">
            <button onClick={onAttach} className="flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-[#faf6ec]">
              <Paperclip className="h-3.5 w-3.5" /> 把文件拖到上方更快
            </button>
            <span className="hidden text-[10px] text-[#9c8b6c] md:inline">
              · 所有回答带原文锚点 · 三类标签 · 可导出报告
            </span>
          </div>
          <button
            onClick={onSubmit}
            disabled={!value.trim() || running}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-[#0c1a2b] text-[#faf6ec] transition hover:bg-[#0c1a2b]/90 disabled:cursor-not-allowed disabled:bg-[#d8cfb8]"
            aria-label="发送"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  </div>
);

function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
      <div
        className="rounded-3xl border-2 border-dashed border-[#a17334] bg-[#fdf3df]/85 px-12 py-10 text-center"
        style={{ boxShadow: "0 30px 80px -30px rgba(12,26,43,0.4)" }}
      >
        <FileUp className="mx-auto h-10 w-10 text-[#a17334]" />
        <p
          className="mt-3 text-xl font-semibold text-[#0c1a2b]"
          style={{ fontFamily: '"Noto Serif SC", serif' }}
        >
          松开以导入法规文件
        </p>
        <p className="mt-1 text-xs text-[#7c6a4f]">支持 PDF / Word · 拖到任意位置均可识别</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 模板切换条
 * --------------------------------------------------------------------------*/

function TemplateBar({ activeId, onChange }: { activeId: TemplateId; onChange: (id: TemplateId) => void }) {
  const [open, setOpen] = useState(false);
  const active = TEMPLATE_BY_ID[activeId];
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-[#d8cfb8] bg-white/70 px-3 py-1.5 text-xs text-[#3a3027] transition hover:border-[#a17334] hover:bg-white"
        aria-expanded={open}
      >
        <active.icon className="h-3.5 w-3.5 text-[#a17334]" />
        <span
          className="font-medium"
          style={{ fontFamily: '"Noto Serif SC", serif' }}
        >
          {active.name}
        </span>
        <span className="text-[10px] text-[#9c8b6c]">· {active.tagline}</span>
        <ChevronDown className={`h-3 w-3 text-[#9c8b6c] transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-[320px] overflow-hidden rounded-xl border bg-white shadow-2xl"
          style={{ borderColor: "#e6dfd0" }}
        >
          <p
            className="px-4 py-3 text-[10px] uppercase tracking-[0.16em] text-[#9c8b6c]"
            style={{ fontFamily: '"Noto Serif SC", serif' }}
          >
            切换模板
          </p>
          <div className="flex flex-col">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
                className={`flex items-start gap-3 px-4 py-3 text-left transition ${
                  t.id === activeId ? "bg-[#fdf3df]" : "hover:bg-[#faf6ec]"
                }`}
              >
                <t.icon className={`mt-0.5 h-4 w-4 ${t.id === activeId ? "text-[#a17334]" : "text-[#7c6a4f]"}`} />
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[13px] font-medium text-[#0c1a2b]"
                    style={{ fontFamily: '"Noto Serif SC", serif' }}
                  >
                    {t.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[#7c6a4f]">{t.tagline}</p>
                </div>
                {t.id === activeId && <CheckCircle2 className="mt-0.5 h-4 w-4 text-[#a17334]" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 结构化 findings 卡片
 * --------------------------------------------------------------------------*/

function FindingsCards({ findings, rawJson, onAskFollowUp }: { findings: Findings; rawJson?: string; onAskFollowUp?: (q: string) => void }) {
  const palette = TEMPLATE_BY_ID[DEFAULT_TEMPLATE_ID].severityPalette;
  const [showRaw, setShowRaw] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set());

  const allSeverities = useMemo(() => {
    const s = new Set<string>();
    findings.changes.forEach((c) => s.add(c.severity));
    return Array.from(s);
  }, [findings.changes]);

  const filteredChanges = useMemo(() => {
    if (severityFilter.size === 0) return findings.changes;
    return findings.changes.filter((c) => severityFilter.has(c.severity));
  }, [findings.changes, severityFilter]);

  const toggleSeverity = (sev: string) => {
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      next.has(sev) ? next.delete(sev) : next.add(sev);
      return next;
    });
  };

  const noFindings = !findings.changes.length && !findings.parameters.length && !findings.evidence.length;
  if (noFindings && !rawJson) return null;
  return (
    <div className="mt-4 space-y-4">
      {findings.changes.length > 0 && (
        <div
          className="overflow-hidden rounded-xl border bg-white"
          style={{ borderColor: "#e6dfd0" }}
        >
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2"
            style={{ borderColor: "#ece4d1" }}
          >
            <p
              className="text-[12px] font-semibold text-[#0c1a2b]"
              style={{ fontFamily: '"Noto Serif SC", serif' }}
            >
              变化点总表 · {filteredChanges.length} 项
            </p>
            <div className="flex items-center gap-2">
              {allSeverities.map((sev) => (
                <button
                  key={sev}
                  onClick={() => toggleSeverity(sev)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition ${
                    severityFilter.has(sev)
                      ? "bg-[#0c1a2b] text-[#faf6ec]"
                      : "bg-[#faf6ec] text-[#7c6a4f] hover:bg-[#fdf3df]"
                  }`}
                >
                  {SEVERITY_LABEL[sev as keyof typeof SEVERITY_LABEL] ?? sev}
                </button>
              ))}
              {severityFilter.size > 0 && (
                <button
                  onClick={() => setSeverityFilter(new Set())}
                  className="text-[10px] text-[#a17334] hover:underline"
                >
                  清除
                </button>
              )}
            </div>
          </div>
          <div className="divide-y" style={{ borderColor: "#f3eddc" }}>
            {findings.changes.map((c) => {
              const tone = palette[c.severity];
              return (
                <div key={c.id} className="grid gap-3 px-4 py-3 md:grid-cols-[110px_1fr]">
                  <div className="flex flex-col items-start gap-1">
                    <span
                      className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {c.id}
                    </span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {SEVERITY_LABEL[c.severity]}
                    </span>
                    <span className="text-[10px] text-[#9c8b6c]">
                      {CHANGE_TYPE_LABEL[c.type]}
                    </span>
                  </div>
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className="text-[13px] font-medium leading-5 text-[#0c1a2b]"
                        style={{ fontFamily: '"Noto Serif SC", serif' }}
                      >
                        {c.title}
                      </p>
                      {onAskFollowUp && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onAskFollowUp(`请查看变化点 ${c.id}「${c.title}」的原文锚点和详细依据`);
                          }}
                          className="shrink-0 rounded-md border border-[#a17334] bg-[#fdf3df] px-2.5 py-1 text-[11px] font-medium text-[#8a5c1a] transition hover:bg-[#a17334] hover:text-white"
                        >
                          追问
                        </button>
                      )}
                    </div>
                    {(c.oldExcerpt || c.newExcerpt) && (
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {c.oldExcerpt && (
                          <div className="rounded-md bg-[#fde0e0]/60 px-2.5 py-2 text-[11px] leading-5 text-[#7a2a2a]">
                            <span className="mb-1 inline-block text-[9px] font-medium uppercase tracking-wider text-[#a23030]">
                              旧文
                            </span>
                            <p>{c.oldExcerpt}</p>
                          </div>
                        )}
                        {c.newExcerpt && (
                          <div className="rounded-md bg-[#dcefe0]/60 px-2.5 py-2 text-[11px] leading-5 text-[#2a5a3a]">
                            <span className="mb-1 inline-block text-[9px] font-medium uppercase tracking-wider text-[#2e6e44]">
                              新文
                            </span>
                            <p>{c.newExcerpt}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {c.productImpact && (
                      <p className="mt-2 text-[11px] leading-5 text-[#7c6a4f]">
                        <span className="text-[10px] font-medium text-[#a17334]">产品影响 · </span>
                        {c.productImpact}
                      </p>
                    )}
                    {c.anchor && (
                      <p className="mt-1.5 font-mono text-[10px] text-[#9c8b6c]">{c.anchor}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {findings.parameters.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: "#e6dfd0" }}>
          <div className="border-b px-4 py-2" style={{ borderColor: "#ece4d1" }}>
            <p className="text-[12px] font-semibold text-[#0c1a2b]" style={{ fontFamily: '"Noto Serif SC", serif' }}>
              专业参数 · {findings.parameters.length} 项
            </p>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-2">
            {findings.parameters.map((p, i) => (
              <div
                key={`${p.name}-${i}`}
                className="rounded-lg border bg-[#f7fbf8] px-3 py-2"
                style={{ borderColor: "#dde7e0" }}
              >
                <p className="text-[11px] font-medium text-[#355f45]">{p.name}</p>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[15px] font-semibold text-[#0c1a2b]">
                    {String(p.newValue ?? "—")}
                  </span>
                  {p.unit && <span className="text-[10px] text-[#7c6a4f]">{p.unit}</span>}
                  {p.oldValue !== undefined && (
                    <span className="text-[10px] text-[#9c8b6c] line-through">
                      {String(p.oldValue)}
                    </span>
                  )}
                </div>
                {p.source && (
                  <p className="mt-1 font-mono text-[10px] text-[#9c8b6c]">{p.source}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {findings.evidence.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: "#e6dfd0" }}>
          <div className="border-b px-4 py-2" style={{ borderColor: "#ece4d1" }}>
            <p className="text-[12px] font-semibold text-[#0c1a2b]" style={{ fontFamily: '"Noto Serif SC", serif' }}>
              联网证据 · {findings.evidence.length} 条
            </p>
          </div>
          <ul className="divide-y" style={{ borderColor: "#f3eddc" }}>
            {findings.evidence.map((e, i) => (
              <li key={`${e.title}-${i}`} className="flex items-start gap-3 px-4 py-2.5">
                <span
                  className="mt-0.5 rounded-full bg-[#e8edf5] px-1.5 py-0.5 text-[10px] text-[#3b4e7a]"
                >
                  {SOURCE_LEVEL_LABEL[e.level]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-[#0c1a2b]">{e.title}</p>
                  <p className="text-[11px] text-[#7c6a4f]">
                    {e.source}
                    {e.retrievedAt ? ` · ${e.retrievedAt}` : ""}
                  </p>
                </div>
                {e.url && (
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-[10px] text-[#a17334] hover:underline">
                    打开
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rawJson && (
        <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: "#e6dfd0" }}>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-[11px] text-[#7c6a4f] hover:bg-[#faf6ec]"
          >
            <span className="flex items-center gap-1.5">
              {showRaw ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span className="font-mono uppercase tracking-wider">查看原始 JSON</span>
            </span>
            <span className="text-[10px] text-[#9c8b6c]">{rawJson.length.toLocaleString()} 字</span>
          </button>
          {showRaw && (
            <pre
              className="max-h-80 overflow-auto border-t p-3 font-mono text-[11px] leading-5 text-[#1c2733]"
              style={{ borderColor: "#ece4d1", backgroundColor: "#faf6ec" }}
            >
              {rawJson}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
/* ----------------------------------------------------------------------------
 * 设置面板
 * --------------------------------------------------------------------------*/

function SettingsPanel({ settings, onSettingsChange }: { settings: { temperature: number; model: string; defaultTemplate: string; maxFileSizeMB: number }; onSettingsChange: (s: any) => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border bg-white p-6" style={{ borderColor: "#e6dfd0" }}>
      <p className="text-lg font-semibold" style={{ fontFamily: '"Noto Serif SC", serif' }}>设置</p>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[#3a3027]">模型</label>
          <select
            value={settings.model}
            onChange={(e) => onSettingsChange({ ...settings, model: e.target.value })}
            className="mt-1 w-full rounded-lg border border-[#d8cfb8] bg-white px-3 py-2 text-sm"
          >
            <option>MiniMax-M3</option>
            <option>DeepSeek-V3</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#3a3027]">Temperature: {settings.temperature.toFixed(2)}</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.temperature}
            onChange={(e) => onSettingsChange({ ...settings, temperature: parseFloat(e.target.value) })}
            className="mt-2 w-full"
          />
          <div className="mt-1 flex justify-between text-[10px] text-[#9c8b6c]">
            <span>精确 (0)</span>
            <span>创意 (1)</span>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#3a3027]">默认模板</label>
          <div className="mt-2 flex gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => onSettingsChange({ ...settings, defaultTemplate: t.id })}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  settings.defaultTemplate === t.id
                    ? "border-[#0c1a2b] bg-[#0c1a2b] text-[#faf6ec]"
                    : "border-[#d8cfb8] hover:border-[#a17334]"
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#3a3027]">单文件大小限制: {settings.maxFileSizeMB} MB</label>
          <input
            type="range"
            min="10"
            max="200"
            step="10"
            value={settings.maxFileSizeMB}
            onChange={(e) => onSettingsChange({ ...settings, maxFileSizeMB: parseInt(e.target.value) })}
            className="mt-2 w-full"
          />
        </div>
        <div className="rounded-lg border border-dashed border-[#d8cfb8] bg-[#faf6ec] p-4">
          <p className="text-xs font-medium text-[#3a3027]">对话历史</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                if (confirm("确定要清空当前对话吗？")) {
                  localStorage.removeItem("rc-conversation");
                  sessionStorage.removeItem("rc-docs");
                  window.location.reload();
                }
              }}
              className="rounded-md border border-[#a23030] px-3 py-1.5 text-xs text-[#a23030] hover:bg-[#fde0e0]"
            >
              清空对话历史
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
