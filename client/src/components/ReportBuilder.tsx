/**
 * ReportBuilder — multi-chapter report generation panel.
 *
 * Flow:
 *   1. POST /api/agent/report/generate  (SSE: outline → chapter_start/content/done → report_complete)
 *   2. POST /api/agent/report/render    (RenderableReport → PDF blob)
 *
 * Shows live progress: outline preview, per-chapter checklist, and the
 * streaming text of the chapter currently being generated.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2, CheckCircle2, CircleDashed, Sparkles } from "lucide-react";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import { reportFileNameFromResponse } from "../lib/reportFileName";
import { assignVersionLabels } from "@shared/versionAssignment";
import { taskHeaders } from "@/lib/taskId";

type ChapterSpec = { id: number; title: string; sections: string[] };
type ReportOutline = {
  title: string;
  chapters: ChapterSpec[];
  appendices: Array<{ id: string; title: string }>;
};

type ChapterState = "pending" | "running" | "done";

type ReportDoc = {
  label: string;
  /** 这个标签是怎么来的：content = 按内容认出来的；positional = 按上传顺序兜底。 */
  labelSource?: "content" | "positional";
  fileName: string;
  text: string;
  pageCount?: number;
  meta?: string;
};

type CompleteReport = {
  outline: ReportOutline;
  chapters: Array<{ id: number; title: string; markdown: string }>;
  // Appendices (A/B/C raw tables, image index, topic cross-check) carry the
  // bulk of the reference content — dropping them shrank the PDF from
  // ~214p to 135p (evaluated: report must contain ALL chapters + appendices).
  appendices?: Array<{ id: string; title: string; markdown?: string }>;
  sourceDocuments: Array<{ label: string; name: string; meta: string }>;
  generatedAt: string;
  /**
   * 产出这份报告的管线：mineru = 已回源复核；llm-sse = 快速草稿（未核验）。
   *
   * **必须一路带着**：客户端把报告原样 POST 给 /report/render，
   * 服务端靠这个字段决定文件名与封面要不要打「未经回源复核」的标。
   * 少了它，草稿会用交付件的文件名下载下来（历史上就是这么漏的）。
   */
  generator?: string;
  /**
   * 参数矩阵（317 行）与它的统计 —— **渲染器要用**：
   * 「MASTER PARAMETER INDEX」就是从 `parameterMatrix` 建的。
   * 客户端**不要挑字段**：整个响应原样带过去。
   */
  parameterMatrix?: unknown[];
  parameterMatrixStats?: Record<string, unknown>;
};

type Props = {
  docs: Array<{
    fileName: string;
    pageCount?: number;
    extractedText?: string;
    localFilePath?: string;
    /** 上传时按内容认出来的版本。 */
    versionGuess?: { label: string | null; score: number; source: string; reason: string };
    /** **用户确认过的**版本（界面上人工改判的 ✓）—— 优先于机器识别 ✓。 */
    confirmedLabel?: string | null;
    /** **文件指纹**（sha256）—— 服务器判案例包适用性要用 ✓。 */
    sha256?: string;
  }>;
  /** **这次对比的任务 id**（同事 issue #2）—— 每个请求都带上它 ✓。 */
  taskId?: string;
  onClose: () => void;
};

const LABELS = ["A", "B", "C", "D", "E", "F"];

export default function ReportBuilder({ docs, taskId, onClose }: Props) {
  const [phase, setPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [outline, setOutline] = useState<ReportOutline | null>(null);
  const [chapterStates, setChapterStates] = useState<Record<number, ChapterState>>({});
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [currentText, setCurrentText] = useState("");
  const [regexStats, setRegexStats] = useState<string>("");
  const [report, setReport] = useState<CompleteReport | null>(null);
  /**
   * 这次跑的是哪条管线。
   *
   * 面板抬头原来只有一句「Regex 提取 + 动态大纲 + 逐章流式生成」，
   * 那**描述的是快速草稿**，却挂在「完整对比报告生成」这个抬头下 ——
   * MinerU 那条路是确定性渲染，根本不流式生成。
   * 用户读到的是「我的报告是模型逐章编出来的」——对交付件来说这句话是假的。
   */
  const [pipeline, setPipeline] = useState<"mineru" | "draft" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [downloading, setDownloading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll the live preview as content streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentText]);

  const start = useCallback(async () => {
    const ready = docs.filter((d) => d.extractedText);
    if (ready.length < 2) {
      toast.error("至少需要 2 份已解析的文档");
      return;
    }
    // **按内容认出来的版本优先**；认不出才退回「按上传顺序」。
    // 原来只有后者 —— 于是「上传顺序 = 版本」成了默认，
    // 认版本这件事从头到尾没人真的做过。
    //
    // 分配逻辑在**共享模块**里（`@shared/versionAssignment` ✓）——
    // 这里不再各写一遍 ✓（两处各写一遍 = 迟早改得不一样 ✓），
    // 而且**可测** ✓（`_test_version_assignment.mjs` ✓）。
    const assign = assignVersionLabels(
      ready.map((d) => ({
        fileName: d.fileName,
        versionGuess: d.versionGuess,
        confirmedLabel: d.confirmedLabel,
      })),
    );
    if (assign.conflicts.length) {
      // **冲突不许静默发出去** ✓ —— 两份都标成同一版时，
      // 后面矩阵拿到的就是**错位的语料** ✓。
      toast.error(
        `版本角色有冲突：${assign.conflicts
          .map((c) => `${c.label} 版被 ${c.files.join(" 与 ")} 同时占用`)
          .join("；")} —— 请在上传列表里确认每份文件的版本`,
      );
      return;
    }
    const documents: ReportDoc[] = ready.map((d, i) => ({
      label: assign.assignments[i]?.label ?? LABELS[i] ?? `D${i + 1}`,
      labelSource:
        assign.assignments[i]?.source === "positional" ? "positional" : "content",
      fileName: d.fileName,
      text: d.extractedText!,
      pageCount: d.pageCount,
      meta: d.pageCount ? `${d.pageCount} 页` : "",
    }));

    setPhase("generating");
    setPipeline("draft");
    setOutline(null);
    setChapterStates({});
    setCurrentId(null);
    setCurrentText("");
    setReport(null);
    setErrorMsg("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent/report/generate", {
        method: "POST",
        headers: taskHeaders(taskId ?? "", { "content-type": "application/json" }),
        body: JSON.stringify({ documents }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (ev: Record<string, unknown>) => {
        switch (ev.type) {
          case "regex_stats":
            setRegexStats(`条款 ${ev.clauses} 条 · 数值 ${ev.values} 条`);
            break;
          case "outline": {
            const o = ev.outline as ReportOutline;
            setOutline(o);
            const states: Record<number, ChapterState> = {};
            for (const c of o.chapters) states[c.id] = "pending";
            setChapterStates(states);
            break;
          }
          case "chapter_start":
            setCurrentId(ev.id as number);
            setCurrentText("");
            setChapterStates((prev) => ({ ...prev, [ev.id as number]: "running" }));
            break;
          case "chapter_content":
            setCurrentText((t) => t + (ev.delta as string));
            break;
          case "chapter_done":
            setChapterStates((prev) => ({ ...prev, [ev.id as number]: "done" }));
            break;
          case "report_complete":
            // generator 显式写死：这条路径**就是** LLM 草稿。
            // 服务端也会带上同一个字段，两边对不上时以服务端为准（渲染时会再核一次）。
            setReport({ ...(ev as unknown as CompleteReport), generator: "llm-sse" });
            setPhase("done");
            break;
          case "error":
            setErrorMsg(ev.message as string);
            setPhase("error");
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            handleEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* partial frame */
          }
        }
      }
      // If we never saw report_complete, mark whatever finished as done.
      setPhase((p) => (p === "generating" ? "done" : p));
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    }
  }, [docs]);

  const downloadPdf = useCallback(async () => {
    if (!report) return;
    setDownloading(true);
    try {
      const res = await fetch("/api/agent/report/render", {
        method: "POST",
        headers: taskHeaders(taskId ?? "", { "content-type": "application/json" }),
        body: JSON.stringify(report),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // 文件名**由服务端从报告的源文档清单派生** —— 换一套标准时自动跟着变，
      // 不会下载出一个名字里还写着 GB 4785 的新标准的报告。
      a.download = reportFileNameFromResponse(res, "pdf");
      a.click();
      URL.revokeObjectURL(url);
      toast.success("报告 PDF 已下载");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF 生成失败");
    } finally {
      setDownloading(false);
    }
  }, [report]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setPipeline(null);
  }, []);

  // MinerU 高精度管线：走 Python sidecar + 确定性渲染，无 LLM 编造。
  const startMineru = useCallback(async () => {
    const ready = docs.filter((d) => d.localFilePath) as Array<{
      fileName: string;
      localFilePath: string;
      versionGuess?: { label: string | null; score: number; source: string; reason: string };
      /** **用户确认过的**版本（界面上人工改判的 ✓）—— 优先于机器识别 ✓。 */
      confirmedLabel?: string | null;
      /** **文件指纹**（sha256）—— 服务器判案例包适用性要用 ✓。 */
      sha256?: string;
    }>;
    if (ready.length < 2) {
      toast.error("MinerU 管线需要至少 2 份已上传到服务器的 PDF（不支持客户端本地提取）");
      return;
    }
    setPhase("generating");
    setPipeline("mineru");
    setErrorMsg("");
    setCurrentText("");
    try {
      // **同一套分配** ✓（与草稿那条路一致 ✓）
      const assign = assignVersionLabels(
        ready.map((d) => ({
          fileName: d.fileName,
          versionGuess: d.versionGuess,
          confirmedLabel: d.confirmedLabel,
        })),
      );
      if (assign.conflicts.length) {
        toast.error(
          `版本角色有冲突：${assign.conflicts
            .map((c) => `${c.label} 版被 ${c.files.join(" 与 ")} 同时占用`)
            .join("；")} —— 请在上传列表里确认每份文件的版本`,
        );
        return;
      }
      const miningToast = toast.loading("MinerU 多模态提取中（约 1-3 分钟/份）…");
      const res = await fetch("/api/agent/report/generate/mineru", {
        method: "POST",
        headers: taskHeaders(taskId ?? "", { "content-type": "application/json" }),
        body: JSON.stringify({
          // 与草稿那条路**同一套分配** ✓（共享模块 ✓ —— 不各写一遍 ✓）
          documents: assign.assignments.map((a, i) => ({
            label: a.label,
            labelSource: a.source === "positional" ? "positional" : "content",
            fileName: ready[i].fileName,
            filePath: ready[i].localFilePath,
            // **文件指纹** —— 服务器判案例包适用性时用的就是它 ✓
            sha256: ready[i].sha256,
          })),
        }),
      });
      toast.dismiss(miningToast);
      if (!res.ok) {
        // 「这套标准尚未配置」是 **422**（不是服务器故障）。
        // 服务端给的是 JSON，其中 `error` 是**人话**（哪份文件不像哪一版、像到多少）——
        // 直接把那一句端出来，别甩一坨 JSON 给用户。
        const raw = await res.text().catch(() => res.statusText);
        let msg = raw.slice(0, 300);
        try {
          const j = JSON.parse(raw) as { error?: string; code?: string };
          if (j.code === "case_pack_not_configured") {
            msg =
              (j.error ?? raw).slice(0, 600) +
              "\n\n下一步：给这套标准**加一个案例包**" +
              "（一份 `data/standard-pack.json` + 一组数据文件），" +
              "程序不用改 —— 见 `delivery/PDF对比/分析报告/换标准操作清单_2026-11-06.md`。";
          } else if (j.error) {
            msg = j.error.slice(0, 300);
          }
        } catch {
          /* 不是 JSON —— 就用原文 */
        }
        throw new Error(msg);
      }
      // /generate/mineru returns RenderableReport JSON → build the client-side
      // report shape for the existing flow.
      const data = (await res.json()) as CompleteReport & {
        outline?: ReportOutline;
        chapters?: Array<{ id: number; title: string; markdown: string }>;
        appendices?: Array<{ id: string; title: string; markdown?: string }>;
      };
      setOutline(data.outline ?? null);
      const states: Record<number, ChapterState> = {};
      for (const c of data.outline?.chapters ?? []) states[c.id] = "done";
      setChapterStates(states);
      setReport({
        // **整个响应原样带过去**，不要挑字段。
        //
        // 原来这里手工列了 outline/chapters/appendices/sourceDocuments/generatedAt
        // 五个字段 —— 看起来够了，但**渲染器还要 `parameterMatrix`**：
        // 「MASTER PARAMETER INDEX」（317 行的主索引，8 页）就是从它建的
        // （htmlRenderV8.ts: `renderMasterParams(extractMasterParams(chapters, report.parameterMatrix))`）。
        // 挑字段 = 把它悄悄丢掉 →
        // **弹窗里那个「下载 PDF」按钮出的是缺 8 页主索引的报告**，
        // 而界面上看不出任何区别。
        //
        // 教训与本项目反复治的病同形：**「我以为我带全了」**。
        ...(data as any),
        outline: data.outline!,
        chapters: data.chapters ?? [],
        appendices: data.appendices ?? [],
        sourceDocuments: (data as any).sourceDocuments ?? [],
        generatedAt: (data as any).generatedAt ?? "",
        // 这条管线是已回源复核的 MinerU 路径 —— 标记要带着走，
        // 否则服务端会把这份已核验的报告当成「来路不明」的打上草稿标。
        generator: (data as any).generator ?? "mineru",
      });
      setPhase("done");
      toast.success("MinerU 高精度报告已生成");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
      toast.error(e instanceof Error ? e.message : "MinerU 报告生成失败");
    }
  }, [docs]);

  const mineruReady = docs.filter((d) => d.localFilePath).length;

  const readyCount = docs.filter((d) => d.extractedText).length;
  const doneCount = Object.values(chapterStates).filter((s) => s === "done").length;
  const totalChapters = outline?.chapters.length ?? 0;
  const totalChars = report
    ? report.chapters.reduce((s, c) => s + c.markdown.length, 0)
    : 0;

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-2xl border bg-white"
      style={{ borderColor: "#e6dfd0", boxShadow: "0 18px 36px -28px rgba(12,26,43,0.18)" }}
    >
      {/* header */}
      <div className="flex items-center justify-between border-b px-5 py-3.5" style={{ borderColor: "#ece4d1" }}>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0c1a2b] text-[#faf6ec]">
            <FileText className="h-4 w-4" />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-[#0c1a2b]" style={{ fontFamily: '"Noto Serif SC", serif' }}>
              完整对比报告生成
            </p>
            {/* 抬头按**哪条管线**说话 —— 原来那句描述的是快速草稿，
                却挂在整个面板的抬头下，MinerU 的交付件也是它。 */}
            <p className="text-[10px] text-[#9c8b6c]">
              {pipeline === "mineru"
                ? "MinerU 多模态提取 + 逐格回源复核 + 专业 PDF"
                : pipeline === "draft"
                  ? "Regex 提取 + 动态大纲 + 逐章流式生成（未经核验）"
                  : "抽取条款/数值 → 逐章三版对照 → 逐格回源复核 → 专业 PDF"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {phase === "idle" && (
            <>
              <button
                onClick={startMineru}
                disabled={mineruReady < 2}
                title={mineruReady < 2 ? "需先上传 PDF（服务端解析）才能走 MinerU 高精度管线" : "本地 MinerU 多模态提取 + 机器核验，约 3-5 分钟，全程无 LLM 编造"}
                className="flex items-center gap-1.5 rounded-md bg-[#a17334] px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-[#8a5f2a] disabled:cursor-not-allowed disabled:bg-[#d8cfb8]"
              >
                <Sparkles className="h-3.5 w-3.5" /> MinerU 高精度报告
              </button>
              <button
                onClick={start}
                disabled={readyCount < 2}
                className="flex items-center gap-1.5 rounded-md bg-[#0c1a2b] px-3.5 py-1.5 text-xs font-medium text-[#faf6ec] transition hover:bg-[#1a2f4a] disabled:cursor-not-allowed disabled:bg-[#d8cfb8]"
              >
                快速草稿（未经核验 · {readyCount} 份文档）
              </button>
            </>
          )}
          {phase === "generating" && (
            <button onClick={cancel} className="rounded-md border border-[#d8cfb8] px-3 py-1.5 text-xs text-[#7c6a4f] hover:bg-[#faf6ec]">
              取消
            </button>
          )}
          {phase === "done" && report && (
            <button
              onClick={downloadPdf}
              disabled={downloading}
              className="flex items-center gap-1.5 rounded-md bg-[#0c1a2b] px-3.5 py-1.5 text-xs font-medium text-[#faf6ec] transition hover:bg-[#1a2f4a] disabled:opacity-60"
            >
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {downloading ? "渲染中…" : "下载 PDF"}
            </button>
          )}
          <button onClick={onClose} className="rounded-md px-2 py-1.5 text-xs text-[#7c6a4f] hover:bg-[#faf6ec]" aria-label="关闭">
            ✕
          </button>
        </div>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {phase === "idle" && (
          <div className="flex flex-col items-center justify-center gap-4 py-14 text-center">
            <Sparkles className="h-9 w-9 text-[#a17334]" />
            <div>
              <p className="text-sm font-medium text-[#0c1a2b]">生成逐章三版对照报告</p>
              <p className="mt-1.5 max-w-md text-xs leading-5 text-[#7c6a4f]">
                <strong>MinerU 高精度路径</strong>：抽取条款/数值 → 逐章三版对照（每格带条款号与页码）
                → <strong>逐格回源 PDF 复核</strong> → HTML→PDF 专业排版，约 2–4 分钟。
                <br />
                <strong>快速草稿路径</strong>：LLM 逐章流式生成（未经回源复核），约 15–20 分钟。
              </p>
            </div>
            <p className="text-[11px] text-[#9c8b6c]">
              已就绪 {readyCount} / {docs.length} 份文档
            </p>
          </div>
        )}

        {(phase === "generating" || phase === "done" || phase === "error") && (
          <>
            {/* status strip */}
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#ece4d1] bg-[#faf6ec] px-4 py-2.5">
              {regexStats && <span className="text-[11px] text-[#7c6a4f]">🔢 {regexStats}</span>}
              {outline && (
                <span className="text-[11px] text-[#7c6a4f]">
                  📋 大纲：{outline.chapters.length} 章 + {outline.appendices.length} 附录
                </span>
              )}
              {totalChapters > 0 && (
                <span className="text-[11px] font-medium text-[#0c1a2b]">
                  章节进度：{doneCount}/{totalChapters}
                </span>
              )}
              {report && <span className="text-[11px] text-[#5e8b66]">📦 总计 {totalChars.toLocaleString()} 字</span>}
              {errorMsg && <span className="text-[11px] text-[#a23030]">❌ {errorMsg}</span>}
            </div>

            {/* progress bar */}
            {totalChapters > 0 && (
              <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-[#ece4d1]">
                <div
                  className="h-full rounded-full bg-[#a17334] transition-all duration-500"
                  style={{ width: `${(doneCount / totalChapters) * 100}%` }}
                />
              </div>
            )}

            {/* chapter checklist + live preview */}
            {outline && (
              <div className="grid gap-4 md:grid-cols-[240px_1fr]">
                <div className="flex flex-col gap-1">
                  {outline.chapters.map((c) => {
                    const st = chapterStates[c.id] ?? "pending";
                    return (
                      <div
                        key={c.id}
                        className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[11.5px] leading-4 transition ${
                          currentId === c.id ? "bg-[#fdf3df] text-[#0c1a2b]" : st === "done" ? "text-[#5e8b66]" : "text-[#9c8b6c]"
                        }`}
                      >
                        {st === "done" ? (
                          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
                        ) : st === "running" ? (
                          <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-[#a17334]" />
                        ) : (
                          <CircleDashed className="mt-px h-3.5 w-3.5 shrink-0" />
                        )}
                        <span>
                          <span className="font-semibold">{c.id}.</span> {c.title}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div ref={scrollRef} className="h-[420px] overflow-y-auto rounded-lg border border-[#ece4d1] bg-[#fbf9f3] p-4">
                  {currentText ? (
                    <div className="rc-prose text-[12.5px] leading-6 text-[#1c2733]">
                      <Streamdown>{currentText}</Streamdown>
                    </div>
                  ) : phase === "generating" ? (
                    <div className="flex h-full items-center justify-center gap-2 text-xs text-[#9c8b6c]">
                      <Loader2 className="h-4 w-4 animate-spin" /> 正在生成…
                    </div>
                  ) : report ? (
                    <div className="space-y-4">
                      {report.chapters.map((ch) => (
                        <div key={ch.id}>
                          <p className="mb-1 text-[13px] font-bold text-[#0c1a2b]">
                            {ch.id} {ch.title}
                            <span className="ml-2 text-[10px] font-normal text-[#9c8b6c]">{ch.markdown.length.toLocaleString()} 字</span>
                          </p>
                          <div className="rc-prose line-clamp-3 text-[12px] leading-6 text-[#5e5240]">{ch.markdown.slice(0, 300)}…</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}

        {phase === "done" && report && (
          <div className="mt-4 rounded-lg border border-[#9fd6b4] bg-[#f0faf4] px-4 py-3">
            <p className="text-[12.5px] font-medium text-[#1f7a44]">
              ✅ 报告生成完成！{report.chapters.length} 章 · {totalChars.toLocaleString()} 字
            </p>
            <p className="mt-1 text-[11px] text-[#3a6b4f]">
              点击右上角「下载 PDF」获取专业排版报告（封面 · 目录 · 逐章对比表格 · 变更标注）。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
