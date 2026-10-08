import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { Bot, FileSearch, FolderOpen, LogOut, Menu, MessageSquare, PanelLeftClose, Settings2, ShieldCheck, SquarePen, WandSparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const DEMO_USER = {
  name: import.meta.env.VITE_DEMO_USER_NAME ?? "Demo 用户",
  email: import.meta.env.VITE_DEMO_USER_EMAIL ?? "demo@regulatory-copilot.local",
};

/**
 * Conversation list derived from the conversation Home.tsx actually persists in
 * localStorage["rc-conversation"]. This used to be a hardcoded 4-item array
 * ("9.22 14点抢票提醒" sitting between regulation tasks) with one row
 * pre-marked active — the sidebar displayed history that never existed.
 */
function useRealConversations() {
  const [convs, setConvs] = useState<{ title: string; meta: string; active: boolean }[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        const saved = localStorage.getItem("rc-conversation");
        if (!saved) return setConvs([]);
        const { messages } = JSON.parse(saved);
        const firstUser = (messages ?? []).find((m: any) => m.role === "user");
        if (!firstUser) return setConvs([]);
        const text = String(firstUser.text ?? "").trim();
        if (!text) return setConvs([]);
        setConvs([
          {
            title: text.length > 24 ? text.slice(0, 24) + "…" : text,
            meta: new Date().toLocaleDateString("zh-CN"),
            active: true,
          },
        ]);
      } catch {
        setConvs([]);
      }
    };
    read();
    // Home.tsx writes on a 500ms debounce, so poll rather than only on mount.
    const t = setInterval(read, 2000);
    return () => clearInterval(t);
  }, []);
  return convs;
}

export default function DashboardLayout({ children, onNavigate }: { children: React.ReactNode; onNavigate?: (view: string) => void }) {
  const { loading, user, logout } = useAuth();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [, setLocation] = useLocation();
  const conversations = useRealConversations();

  const nav = (view: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const path = view === "compare" ? "/" : `/${view}`;
    if (onNavigate) {
      onNavigate(view);
      return;
    }
    // Use wouter's real navigation rather than pushState + a synthetic
    // popstate: the manual dispatch re-entered the router through the history
    // event path and was easy to miss when debugging "the sidebar does nothing".
    if (setLocation) {
      setLocation(path);
      return;
    }
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Demo mode: when the runtime was launched without OAuth portal config (or
  // VITE_DEMO_MODE is explicitly set), skip the login wall and render the app
  // with a placeholder user so the agent UI is reachable for investor demos.
  const demoMode = import.meta.env.VITE_DEMO_MODE === "true" || !import.meta.env.VITE_OAUTH_PORTAL_URL;
  const effectiveUser = demoMode
    ? user ?? DEMO_USER
    : user;

  if (loading && !demoMode) return <div className="min-h-screen bg-[#f7f7f7]" />;
  if (!effectiveUser) return <div className="flex min-h-screen items-center justify-center bg-[#f7f7f7]"><div className="w-full max-w-md rounded-3xl bg-white p-10 text-center shadow-xl"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#171717] text-xl font-bold text-white">RA</div><h1 className="mt-6 text-2xl font-semibold text-[#171717]">进入法规智能体</h1><p className="mt-3 text-sm leading-6 text-slate-500">上传法规、提出问题，让 Agent 帮你完成对比和研究。</p><Button onClick={() => startLogin()} className="mt-8 h-11 w-full rounded-xl bg-[#171717] hover:bg-black">开始使用</Button></div></div>;

  return <div className="min-h-screen bg-[#f7f7f7] text-[#202020]">
    {isMobile && <div className="sticky top-0 z-50 flex h-14 items-center gap-3 border-b border-[#e7e7e7] bg-[#fafafa]/95 px-4 backdrop-blur"><button onClick={() => setCollapsed(false)} aria-label="展开侧栏" className="rounded-lg p-2 hover:bg-white"><Menu className="h-5 w-5" /></button><span className="text-sm font-semibold">法规智能体</span></div>}
    <aside className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[#e6e6e6] bg-[#f3f3f3] transition-transform duration-200 ${isMobile ? (collapsed ? "-translate-x-full" : "translate-x-0") : "translate-x-0"} ${isMobile ? "w-[286px]" : "w-[276px]"}`}>
      <div className="flex h-[68px] items-center justify-between px-4"><div className="flex items-center gap-2.5"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1f1f1f] text-white"><Bot className="h-5 w-5" /></div><div><p className="text-sm font-semibold tracking-tight">法规智能体</p><p className="text-[10px] text-slate-500">Regulatory Copilot</p></div></div>{isMobile ? <button onClick={() => setCollapsed(true)} aria-label="收起侧栏" className="rounded-lg p-2 text-slate-400 hover:bg-white"><X className="h-4 w-4" /></button> : <button onClick={() => setCollapsed(true)} aria-label="收起侧栏" className="rounded-lg p-2 text-slate-400 hover:bg-white"><PanelLeftClose className="h-4 w-4" /></button>}</div>
      <div className="px-3"><button onClick={() => window.location.href = "/"} className="flex h-10 w-full items-center gap-3 rounded-xl bg-white px-3 text-sm font-medium shadow-sm transition hover:shadow"><SquarePen className="h-4 w-4" />新对话</button></div>
      <nav className="mt-3 flex-1 overflow-auto px-3"><p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">工作区</p><div className="space-y-1"><button onClick={nav("compare")} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-xs text-slate-500 hover:bg-white"><WandSparkles className="h-4 w-4 text-[#4d63c9]" />法规对比任务</button><button onClick={nav("review")} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-xs text-slate-500 hover:bg-white"><ShieldCheck className="h-4 w-4" />审阅工作台</button><button onClick={nav("projects")} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-xs text-slate-500 hover:bg-white"><FolderOpen className="h-4 w-4" />我的项目</button><button onClick={nav("documents")} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-xs text-slate-500 hover:bg-white"><FileSearch className="h-4 w-4" />资料与引用</button></div><p className="px-3 pb-2 pt-7 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">历史对话</p><div className="space-y-0.5">{conversations.length === 0 ? <p className="px-3 py-2 text-[11px] leading-relaxed text-slate-400">暂无历史对话。提问后会自动保存在本机。</p> : conversations.map(item => <button key={item.title} onClick={() => { window.location.href = "/"; }} title="打开该对话" className={`group flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left ${item.active ? "bg-white shadow-sm" : "hover:bg-white/70"}`}><MessageSquare className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${item.active ? "text-[#4d63c9]" : "text-slate-400"}`} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-[#333]">{item.title}</span><span className="mt-1 block text-[10px] text-slate-400">{item.meta}</span></span>{item.active && <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#4d63c9]" />}</button>)}</div></nav>
      <div className="border-t border-[#e2e2e2] p-3"><button onClick={nav("settings")} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-xs text-slate-500 hover:bg-white"><Settings2 className="h-4 w-4" />设置</button><div className="mt-3 flex items-center gap-2 rounded-xl bg-white/70 p-2"><Avatar className="h-8 w-8"><AvatarFallback className="bg-[#202020] text-xs text-white">{effectiveUser.name?.charAt(0).toUpperCase() || "A"}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{effectiveUser.name || "法规负责人"}</p><p className="truncate text-[10px] text-slate-400">{effectiveUser.email || "已登录"}</p></div><button onClick={logout} className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700" aria-label="退出登录"><LogOut className="h-3.5 w-3.5" /></button></div></div>
    </aside>
    <main className={`${isMobile ? "pl-0" : "pl-[276px]"} min-h-screen`}>{!isMobile && collapsed && <button onClick={() => setCollapsed(false)} className="fixed left-4 top-4 z-50 rounded-xl border border-[#e4e4e4] bg-white p-2 shadow-sm"><Menu className="h-4 w-4" /></button>}{children}</main>
  </div>;
}
