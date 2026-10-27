/**
 * ReviewWorkbench — 审阅工作台（/review）
 *
 * 解决 PDF 的核心问题：可信度信息都埋在第 10-11 章深处，读者翻不到，
 * 于是"78% 待复核""9 条假差异""网传指标证伪"这些结论等于没传达。
 *
 * 三个模块（全部读 /api/agent/report/trust 的只读投影，不重造数据）：
 *   1. 可信度仪表盘  — 5 类闭环统计 + verifier 告警清单
 *   2. 假差异工作台  — §11.3.0 同文勘误逐条，支持人工确认/驳回并回写
 *   3. 网传指标证伪  — §11.0 九条行业流传指标 × A/B 出处核验
 *
 * 本页**只读**。核验是 agent 的职责，不是人的：检测结果由 trustChecks
 * /consistency 在渲染期算出，读者需要的是「结论 + 出处」，不是一条条
 * 点确认按钮 —— 那会把机器能做的活抢走，还会引入 verdicts.json 这个
 * 会在报告重生成后残留的状态源。
 *
 * 用户发现疑点时点右上角「重新核验」→ POST /api/agent/report/trust/recheck，
 * 服务端重跑一遍自动核验并覆盖结果（顺带清掉可能残留的旧 verdicts.json）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronUp,
  FileWarning,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

type Counts = {
  confirmed: number;
  /** §11.3.1 人工核验补录 —— 双源核验，但不在 18 个固定对比主题内 */
  manual: number;
  candidate: number;
  errata: number;
  renum: number;
  format: number;
};

type Dashboard = { counts: Counts; total: number; candidateShare: number };

type Erratum = {
  no: string;
  topic: string;
  bValue: string;
  aValue: string;
  reason: string;
};

type Rumor = {
  metric: string;
  bValue: string;
  aValue: string;
  verdict: string;
  status: string;
};

type Warning = { label: string; status: string; detail: string; evidence?: string };

/** Structural integrity gate (trustChecks.assessIntegrity). */
type IntegrityCheck = { label: string; status: "pass" | "warn" | "fail"; detail: string };
type IntegrityGate = {
  level: "ok" | "degraded" | "blocked";
  checks: IntegrityCheck[];
  blockers: IntegrityCheck[];
};

type TrustPayload = {
  dashboard: Dashboard;
  errata: Erratum[];
  rumors: Rumor[];
  warnings: Warning[];
  integrity?: IntegrityGate;
  generatedAt: string | null;
};

type Tab = "dashboard" | "errata" | "rumors";

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "dashboard", label: "可信度仪表盘", hint: "全报告差异条目的闭环状态" },
  { id: "errata", label: "假差异工作台", hint: "同文假差异逐条人工确认" },
  { id: "rumors", label: "网传指标证伪", hint: "行业流传数据的两版出处核验" },
];

const INK = "#0c1a2b";
const MUTED = "#7c6a4f";
const LINE = "#e6dfd0";

export default function ReviewWorkbench() {
  const [data, setData] = useState<TrustPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [rechecking, setRechecking] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/report/trust");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as TrustPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const res = await fetch("/api/agent/report/trust/recheck", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      await load();
      toast.success(
        `重新核验完成（${(out.tookMs / 1000).toFixed(1)} 秒）：` +
        `候选 ${out.dashboard.counts.candidate} · 勘误 ${out.dashboard.counts.errata} · ` +
        `完整性 ${out.integrity.level}`,
      );
    } catch (e) {
      toast.error(`重新核验失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRechecking(false);
    }
  }, [load]);

  const stats = useMemo(() => {
    if (!data) return null;
    const { counts, total } = data.dashboard;
    const seg = (n: number, color: string) => (total > 0 ? (100 * n) / total : 0);
    return {
      total,
      candidateShare: data.dashboard.candidateShare,
      segOk: seg(counts.confirmed, "#3a6b4f"),
      segManual: seg(counts.manual ?? 0, "#5b7c99"),
      segWarn: seg(counts.candidate, data.dashboard.candidateShare >= 50 ? "#c9542a" : "#b9a173"),
      segErrata: seg(counts.errata, "#9c8b6c"),
      segRenum: seg(counts.renum, "#c0b89c"),
      segFormat: seg(counts.format, "#d9cfb6"),
    };
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-2xl border bg-white py-24" style={{ borderColor: LINE }}>
        <Loader2 className="h-5 w-5 animate-spin text-[#a17334]" />
        <span className="ml-3 text-sm" style={{ color: MUTED }}>正在载入审阅数据…</span>
      </div>
    );
  }

  if (error || !data || !stats) {
    return (
      <div className="rounded-2xl border bg-white p-8" style={{ borderColor: LINE }}>
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "#c9542a" }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: INK }}>无法载入审阅数据</p>
            <p className="mt-1 text-xs" style={{ color: MUTED }}>
              {error ?? "尚未生成报告。请先在「法规对比任务」页生成完整报告，再回到审阅工作台。"}
            </p>
            <button
              onClick={() => void load()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium"
              style={{ borderColor: LINE, color: INK }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> 重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  const highRisk = data.dashboard.candidateShare >= 50;

  return (
    <div className="flex flex-col gap-5">
      {/* ── 顶部：可信度一句话结论 ── */}
      <header className="rounded-2xl border bg-white p-5" style={{ borderColor: LINE }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold" style={{ fontFamily: '"Noto Serif SC", serif', color: INK }}>
              审阅工作台 · Report Trust Workbench
            </h1>
            <p className="mt-1 text-xs" style={{ color: MUTED }}>
              把 PDF 第 10–11 章深处的可信度结论抬到这里：{stats.total} 条闭环条目里{" "}
              <strong style={{ color: highRisk ? "#c9542a" : "#3a6b4f" }}>
                {data.dashboard.counts.candidate} 条（{stats.candidateShare}%）带 ⚠ 标记
              </strong>
              —— 原文摘录不全 / 单源 / 缺页码（判定已给，但引文或页码不完整）。
              §11.4 的 9 条网传指标<strong>已逐条裁定</strong>，不计入待复核。所有结论由 agent 自动核验，可随时重新核验。
            </p>
          </div>
          <button
            onClick={() => void recheck()}
            disabled={rechecking}
            title="让 agent 重跑一遍自动核验（页码 / 条款 / 数值 / 术语 / 重复），结果立即刷新"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            style={{ borderColor: rechecking ? "#a17334" : LINE, color: INK }}
          >
            {rechecking
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            {rechecking ? "核验中…" : "重新核验"}
          </button>
        </div>

        {/* 占比条 */}
        <div className="mt-4">
          <div className="flex h-3.5 w-full overflow-hidden rounded-full">
            <div style={{ width: `${stats.segOk}%`, background: "#3a6b4f" }} />
            <div style={{ width: `${stats.segManual}%`, background: "#5b7c99" }} />
            <div style={{ width: `${stats.segWarn}%`, background: highRisk ? "#c9542a" : "#b9a173" }} />
            <div style={{ width: `${stats.segErrata}%`, background: "#9c8b6c" }} />
            <div style={{ width: `${stats.segRenum}%`, background: "#c0b89c" }} />
            <div style={{ width: `${stats.segFormat}%`, background: "#d9cfb6" }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]" style={{ color: MUTED }}>
            <span><b style={{ color: "#3a6b4f" }}>✅</b> 已核验 {stats.segOk.toFixed(0)}%</span>
            <span><b style={{ color: "#5b7c99" }}>🧾</b> 人工补录 {stats.segManual.toFixed(0)}%</span>
            <span><b style={{ color: highRisk ? "#c9542a" : "#b9a173" }}>⚠</b> 待复核 {stats.candidateShare}%</span>
            <span><b style={{ color: "#9c8b6c" }}>🟡</b> 同文勘误 {stats.segErrata.toFixed(0)}%</span>
            <span><b style={{ color: "#c0b89c" }}>🔢</b> 编号重排 {stats.segRenum.toFixed(0)}%</span>
            <span><b style={{ color: "#d9cfb6" }}>✍</b> 格式改写 {stats.segFormat.toFixed(0)}%</span>
          </div>
        </div>

        {highRisk && (
          <p
            className="mt-4 rounded-lg px-3 py-2 text-xs leading-relaxed"
            style={{ background: "#fbede2", color: "#c9542a", borderLeft: "3px solid #c9542a" }}
          >
            ⚠ <strong>风险提示</strong>：{stats.candidateShare}% 的条目带 ⚠ 标记（摘录不全 / 缺页码）—— 采信前请回原文补齐。
            ✅ 与 🧾 计入「实质技术变化」总数，🟡 / 🔢 / ✍ 不计入。合规判定必须查阅官方原始标准文本。
          </p>
        )}
      </header>

      {/* ── Tab ── */}
      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const active = tab === t.id;
          const badge =
            t.id === "errata"
              ? data.errata.length
              : t.id === "rumors"
                ? data.rumors.filter((r) => r.status === "两版原文均无出处").length
                : data.warnings.length;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="rounded-lg border px-3.5 py-2 text-left transition-colors"
              style={{
                borderColor: active ? "#a17334" : LINE,
                background: active ? "#fdf3df" : "#fff",
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold" style={{ color: active ? "#a17334" : INK }}>
                  {t.label}
                </span>
                {badge > 0 && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: active ? "#a17334" : "#f0eada", color: active ? "#fff" : "#7c6a4f" }}
                  >
                    {badge}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px]" style={{ color: MUTED }}>{t.hint}</p>
            </button>
          );
        })}
      </nav>

      {/* ── 模块 1：仪表盘 ── */}
      {tab === "dashboard" && (
        <div className="flex flex-col gap-4">
          {/* 完整性门禁：抽取/生成失败时这里会红色报警 */}
          {data.integrity && data.integrity.level !== "ok" && (
            <section
              className="rounded-2xl border p-5"
              style={{
                borderColor: data.integrity.level === "blocked" ? "#c9542a" : "#c0a86a",
                background: data.integrity.level === "blocked" ? "#fbede2" : "#fdf8ee",
              }}
            >
              <div className="flex items-start gap-3">
                <ShieldAlert
                  className="mt-0.5 h-5 w-5 shrink-0"
                  style={{ color: data.integrity.level === "blocked" ? "#c9542a" : "#a17334" }}
                />
                <div className="min-w-0 flex-1">
                  <h2
                    className="text-sm font-semibold"
                    style={{ color: data.integrity.level === "blocked" ? "#c9542a" : "#a17334" }}
                  >
                    {data.integrity.level === "blocked"
                      ? "报告完整性检查未通过 — PDF 导出已被阻止"
                      : "报告完整性检查发现隐患"}
                  </h2>
                  <ul className="mt-2 space-y-1.5">
                    {data.integrity.checks
                      .filter((c) => c.status !== "pass")
                      .map((c) => (
                        <li key={c.label} className="text-xs leading-relaxed" style={{ color: "#5e5240" }}>
                          <span
                            className="mr-1.5 inline-block font-semibold"
                            style={{ color: c.status === "fail" ? "#c9542a" : "#a17334" }}
                          >
                            {c.status === "fail" ? "✗" : "!"}
                          </span>
                          <b>{c.label}</b> — {c.detail.replace(/\*\*/g, "")}
                        </li>
                      ))}
                  </ul>
                  {data.integrity.level === "blocked" && (
                    <p className="mt-3 text-[11px]" style={{ color: "#8a7a5c" }}>
                      原因通常是抽取环节失败（源 PDF 为扫描件 / 加密）或生成中断。修复抽取后重新生成报告；
                      若确认内容无误，可在请求 URL 加 <code>?force=1</code> 强制导出。
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* 完整性全绿时的轻量提示 */}
          {data.integrity && data.integrity.level === "ok" && (
            <div
              className="flex items-center gap-2.5 rounded-xl border px-4 py-2.5"
              style={{ borderColor: "#cfe0d3", background: "#f4f9f5" }}
            >
              <BadgeCheck className="h-4 w-4 shrink-0" style={{ color: "#3a6b4f" }} />
              <p className="text-xs" style={{ color: "#3a6b4f" }}>
                完整性检查通过 — 无空章节 ·{" "}
                {data.integrity.checks.find((c) => c.label.includes("页码"))?.detail ?? "页码锚点正常"} ·{" "}
                {data.integrity.checks.find((c) => c.label.includes("版本标记"))?.detail ?? "三栏标记齐全"}
              </p>
            </div>
          )}

          <section className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: LINE }}>
            <div className="border-b px-5 py-3" style={{ borderColor: LINE }}>
              <h2 className="text-sm font-semibold" style={{ color: INK }}>5 类差异闭环统计</h2>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "#fdf3df" }}>
                  {["标记", "类别", "数量", "占比", "含义"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "#a17334" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ["✅", "已双源核验", data.dashboard.counts.confirmed, "A、B 原文与页码均已定位，可作为变更依据", "#3a6b4f"],
                  ["⚠", "待复核", data.dashboard.counts.candidate, "原文摘录不全 / 单源 / 缺页码 —— 判定已给但引文不完整，使用前必须回原文补齐", highRisk ? "#c9542a" : "#b9a173"],
                  ["🟡", "同文勘误", data.dashboard.counts.errata, "文本差异但实质内容相同（常见于 B 列摘录截断）", "#9c8b6c"],
                  ["🔢", "仅编号重排", data.dashboard.counts.renum, "章节号变更但技术内容不变，不计入技术变化", "#c0b89c"],
                  ["✍", "格式同义改写", data.dashboard.counts.format, "标点 / 措辞差异，技术含义一致", "#d9cfb6"],
                ] as const).map(([icon, label, n, note, color]) => (
                  <tr key={label} className="border-t" style={{ borderColor: "#f0eada" }}>
                    <td className="px-4 py-2.5 text-base">{icon}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: INK }}>{label}</td>
                    <td className="px-4 py-2.5 text-base font-semibold" style={{ color, fontFamily: "ui-monospace, monospace" }}>{n}</td>
                    <td className="px-4 py-2.5" style={{ color: MUTED }}>
                      {stats.total > 0 ? Math.round((n / stats.total) * 100) : 0}%
                    </td>
                    <td className="px-4 py-2.5" style={{ color: MUTED }}>{note}</td>
                  </tr>
                ))}
                <tr className="border-t-2" style={{ borderColor: "#a17334", background: "#f7f1e3" }}>
                  <td className="px-4 py-2.5" />
                  <td className="px-4 py-2.5 font-semibold" style={{ color: INK }}>合计</td>
                  <td className="px-4 py-2.5 text-base font-bold" style={{ color: INK }}>{stats.total}</td>
                  <td className="px-4 py-2.5" style={{ color: MUTED }}>100%</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </section>

          <section className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: LINE }}>
            <div className="border-b px-5 py-3" style={{ borderColor: LINE }}>
              <h2 className="text-sm font-semibold" style={{ color: INK }}>
                自动校验告警
                <span className="ml-2 text-[11px] font-normal" style={{ color: MUTED }}>
                  完整性门禁（进程内）+ 数据交叉校验
                </span>
              </h2>
            </div>
            {data.warnings.length === 0 && (!data.integrity || data.integrity.checks.every((c) => c.status === "pass")) ? (
              <p className="px-5 py-6 text-xs" style={{ color: MUTED }}>无告警 —— 全部校验项通过。</p>
            ) : (
              <ul>
                {[...data.integrity?.checks ?? [], ...data.warnings].map((w) => (
                  <li key={w.label} className="border-b px-5 py-3 last:border-b-0" style={{ borderColor: "#f0eada" }}>
                    <div className="flex items-start gap-2.5">
                      {w.status === "pass" ? (
                        <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#3a6b4f" }} />
                      ) : w.status === "warn" ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#a17334" }} />
                      ) : (
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#c9542a" }} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold" style={{ color: INK }}>{w.label}</p>
                        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: MUTED }}>{w.detail.replace(/\*\*/g, "")}</p>
                        {w.evidence && (
                          <p
                            className="mt-1.5 truncate rounded px-2 py-1 text-[10px]"
                            style={{ background: "#fbf6f0", color: "#8a7a5c", fontFamily: "ui-monospace, monospace" }}
                            title={w.evidence.replace(/\*\*/g, "")}
                          >
                            {w.evidence.replace(/\*\*/g, "")}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* ── 模块 2：假差异工作台 ── */}
      {tab === "errata" && (
        <section className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: LINE }}>
          <div className="border-b px-5 py-3" style={{ borderColor: LINE }}>
            <h2 className="text-sm font-semibold" style={{ color: INK }}>同文假差异 · 逐条人工确认</h2>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: MUTED }}>
              这些条目曾被初筛误判为「草案修改」，实为 <strong>B 列摘录截断</strong> 造成的同文假象。
              逐条回原文核对后确认，可将对应 ⚠ 条目标记为 ✅。
            </p>
          </div>
          {data.errata.length === 0 ? (
            <p className="px-5 py-6 text-xs" style={{ color: MUTED }}>本报告未识别到同文假差异。</p>
          ) : (
            <ul>
              {data.errata.map((e) => {
                const id = `errata:${e.no}`;
                const isOpen = expanded[id];
                // **「重复行」不是「假差异」。**
                // §11.3.0 第 09 行「转向信号灯首次熄灭时间」的降级依据是
                // 「与前一条同参数、同页码（重复行）」——
                // 它的**真实判定在 §11.3.3 第 16 行，是「有变化」**。
                // 挂「假差异 · 勿提变更单」的牌子，工程师就会把
                // 报告第一条真变化（chg01）划掉。
                const isDup = /重复行/.test(e.reason ?? "");
                return (
                  <li key={id} className="border-b last:border-b-0" style={{ borderColor: "#f0eada" }}>
                    <button
                      onClick={() => setExpanded((s) => ({ ...s, [id]: !s[id] }))}
                      className="flex w-full items-center gap-3 px-5 py-3 text-left"
                    >
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold"
                        style={{ background: "#f0eada", color: "#7c6a4f",
                        }}
                      >
                        {e.no}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium" style={{ color: INK }}>
                          {e.topic}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px]" style={{ color: MUTED }}>
                          B：{e.bValue} → A：{e.aValue}
                        </span>
                      </span>
                      <span
                        className="shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#fdf3df", color: "#a17334" }}
                      >
                        {isDup ? "重复行 · 真实判定见 11.3.3" : "假差异 · 勿提变更单"}
                      </span>
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4 shrink-0" style={{ color: MUTED }} />
                      ) : (
                        <ChevronDown className="h-4 w-4 shrink-0" style={{ color: MUTED }} />
                      )}
                    </button>

                    {isOpen && (
                      <div className="px-5 pb-4" style={{ background: "#fdfbf6" }}>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="rounded-lg border p-3" style={{ borderColor: "#dbe2ea", background: "#eef1f5" }}>
                            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#0c1a2b" }}>
                              B 现行 · 摘录（截断）
                            </p>
                            <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "#1c2733" }}>{e.bValue}</p>
                          </div>
                          <div className="rounded-lg border p-3" style={{ borderColor: "#e5d6a8", background: "#fdf3df" }}>
                            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#a17334" }}>
                              A 草案 · 完整值
                            </p>
                            <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "#1c2733" }}>{e.aValue}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: MUTED }}>
                          <strong style={{ color: "#9c8b6c" }}>降级依据：</strong>{e.reason}
                        </p>
                        <p className="mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed"
                           style={{ background: "#f4f1ea", color: "#5e5240" }}>
                          <b>如何核实这一条</b>：按上方页码打开 A / B 两版原文，逐字比对同一条款的完整表述。
                          {isDup ? (
                            <>
                              本行是<b>重复行</b>（与 §11.3.3 里的另一行同参数、同页码）——
                              <b>真实判定在 §11.3.3</b>，那一行可能判为「有变化」。
                              <b>不要因为这一行就跳过这个参数。</b>
                            </>
                          ) : (
                            <>
                              本条属 {e.reason?.includes("截断") ? "「B 列摘录被截断」" : "「双版同文」"}
                              所致的<b>假差异</b>，<b>不应据此提出产品变更</b>。
                            </>
                          )}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ── 模块 3：网传指标证伪 ── */}
      {tab === "rumors" && (
        <section className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: LINE }}>
          <div className="border-b px-5 py-3" style={{ borderColor: LINE }}>
            <h2 className="text-sm font-semibold" style={{ color: INK }}>行业网传指标 · 两版出处核验</h2>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: MUTED }}>
              行业流传的「GB4785 表 11.6 共 9 项指标」，逐条回 A/B 两份原文核验。
              <strong style={{ color: "#c9542a" }}>两版原文均无出处</strong>的条目属此前误传，
              请勿写入测试规范或对外材料。
            </p>
          </div>
          {data.rumors.length === 0 ? (
            <p className="px-5 py-6 text-xs" style={{ color: MUTED }}>本报告未包含网传指标核验表。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead>
                  <tr style={{ background: "#fdf3df" }}>
                    {["指标", "B 现行（GB4785-2019）", "A 草案（V4.3.5）", "核验结论", "出处状态"].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "#a17334" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rumors.map((r) => {
                    const none = r.status === "两版原文均无出处";
                    const single = r.status.includes("单边");
                    return (
                      <tr key={r.metric} className="border-t" style={{ borderColor: "#f0eada", background: none ? "#fbf6f0" : "#fff" }}>
                        <td className="px-4 py-2.5 font-medium" style={{ color: INK }}>{r.metric}</td>
                        <td className="px-4 py-2.5" style={{ color: r.bValue === "—" ? "#b9a173" : "#1c2733" }}>{r.bValue}</td>
                        <td className="px-4 py-2.5" style={{ color: r.aValue === "—" ? "#b9a173" : "#1c2733" }}>{r.aValue}</td>
                        <td className="px-4 py-2.5" style={{ color: MUTED }}>{r.verdict}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold"
                            style={{
                              background: none ? "#fbede2" : single ? "#fdf3df" : "#e3f2e8",
                              color: none ? "#c9542a" : single ? "#a17334" : "#3a6b4f",
                            }}
                          >
                            {none ? <FileWarning className="h-3 w-3" /> : <BadgeCheck className="h-3 w-3" />}
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}