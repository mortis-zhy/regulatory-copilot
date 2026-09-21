/**
 * Preset templates for the Regulatory Copilot. Each template shapes the system
 * prompt sent to MiniMax-M3, the suggested tasks shown to the user, and the
 * default severity / color palette for the structured findings.
 */

import type { LucideIcon } from "lucide-react";
import {
  GitCompareArrows,
  Globe2,
  Layers,
  Sparkles,
} from "lucide-react";

export type TemplateId = "gb" | "eu" | "internal" | "free";

export type Template = {
  id: TemplateId;
  name: string;
  tagline: string;
  icon: LucideIcon;
  /** Server-side system prompt prefix — appended to the universal rules. */
  systemPrompt: string;
  /** Suggested first questions to seed the conversation. */
  suggestedTasks: Array<{ label: string; icon: LucideIcon }>;
  /** Severity → accent color tokens used by the structured finding cards. */
  severityPalette: Record<"high" | "medium" | "low" | "info", { bg: string; fg: string; ring: string }>;
};

export const SEVERITY_PALETTE = {
  high: { bg: "#fde0e0", fg: "#a23030", ring: "#a23030" },
  medium: { bg: "#fdf3df", fg: "#a17334", ring: "#a17334" },
  low: { bg: "#eaf2ec", fg: "#3a6b4d", ring: "#3a6b4d" },
  info: { bg: "#e8edf5", fg: "#3b4e7a", ring: "#3b4e7a" },
};

export const TEMPLATES: Template[] = [
  {
    id: "gb",
    name: "国标对比",
    tagline: "GB 草案 · 现行版 · 修订建议",
    icon: GitCompareArrows,
    systemPrompt:
      "你正在协助中国国家强制性/推荐性标准（GB / GB-T / GB-Z）的版本对比。所有结论优先引用章节号 + 条号 + 表号；参数差异必须给出旧值 / 新值 / 单位 / 来源。当草案与现行版不一致时，请用【原文事实】给出原文、【模型推断】给出影响分析、【待人工确认】标注需要法务或认证团队复核的事项。",
    suggestedTasks: [
      { label: "抽取所有数值、单位、适用范围与例外条件", icon: Layers },
      { label: "列出影响产品设计的全部变化", icon: Sparkles },
      { label: "对比新旧版本章节结构差异", icon: GitCompareArrows },
      { label: "联网核验草案的发布状态与生效日期", icon: Globe2 },
    ],
    severityPalette: SEVERITY_PALETTE,
  },
  {
    id: "eu",
    name: "欧标对应",
    tagline: "UNECE · ISO · IEC 映射",
    icon: Globe2,
    systemPrompt:
      "你正在协助国际法规（UNECE / ISO / IEC / EN）的对比与对应关系分析。请在结论里标注法规编号 + 修订号 + 章节号 + 表号，并指出与国标的对应关系（一对一、多对一或不一致）。所有国际条款请给出原文条款编号；无法核实时使用【待人工确认】前缀。",
    suggestedTasks: [
      { label: "建立与 UN R48 / ISO 等国标的对应表", icon: Layers },
      { label: "抽取适用范围与豁免条款", icon: Sparkles },
      { label: "列出与目标市场的合规差异", icon: GitCompareArrows },
      { label: "联网核验 EC / UNECE 官网的最新状态", icon: Globe2 },
    ],
    severityPalette: SEVERITY_PALETTE,
  },
  {
    id: "internal",
    name: "内部规范",
    tagline: "内部 SOP · 与外部法规对齐",
    icon: Layers,
    systemPrompt:
      "你正在协助企业内部规范（SOP / 技术规范 / 内部标准）与外部法规的差距分析。请标注内部文件章节 + 外部法规锚点 + 差异类型（缺失 / 多余 / 不一致 / 措辞偏差）。所有结论给出责任人建议（合规 / 工程 / 测试）；无法核实使用【待人工确认】。",
    suggestedTasks: [
      { label: "抽取内部规范中所有强制条款", icon: Layers },
      { label: "列出与外部法规的差距清单", icon: GitCompareArrows },
      { label: "对比新旧版本内部规范", icon: Sparkles },
      { label: "标记需要更新的内部文件清单", icon: Globe2 },
    ],
    severityPalette: SEVERITY_PALETTE,
  },
  {
    id: "free",
    name: "自由模式",
    tagline: "通用对比 · 自定义指令",
    icon: Sparkles,
    systemPrompt:
      "你正在协助通用文档对比分析。请按用户的具体指令输出，区分【原文事实】、【模型推断】、【待人工确认】三类信息，并尽量给出原文锚点（章节 / 页码 / 表号）。",
    suggestedTasks: [
      { label: "总结两份文档的差异要点", icon: Sparkles },
      { label: "抽取关键参数与数值", icon: Layers },
      { label: "按主题分组归类差异", icon: GitCompareArrows },
      { label: "给出可操作的变更建议", icon: Globe2 },
    ],
    severityPalette: SEVERITY_PALETTE,
  },
];

export const TEMPLATE_BY_ID: Record<TemplateId, Template> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
) as Record<TemplateId, Template>;

export const DEFAULT_TEMPLATE_ID: TemplateId = "gb";