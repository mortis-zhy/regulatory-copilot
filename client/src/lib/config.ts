/**
 * Client-side configuration constants.
 * Values that vary by deployment (model, context limits, thresholds)
 * should be overridden via Vite env vars at build time.
 */

export const APP_CONFIG = {
  // Model display name (shown in the UI)
  modelDisplayName: import.meta.env.VITE_MODEL_DISPLAY_NAME ?? "MiniMax-M3",

  // Model context window size in characters (used for budget calculations)
  modelContextChars: Number(import.meta.env.VITE_MODEL_CONTEXT_CHARS ?? "128000"),

  // Budget reserved for system prompt + history + user query
  systemBudgetChars: Number(import.meta.env.VITE_SYSTEM_BUDGET_CHARS ?? "20000"),

  // Minimum doc text length to trigger multi-doc Map-Reduce analysis
  multiDocThresholdChars: Number(import.meta.env.VITE_MULTI_DOC_THRESHOLD_CHARS ?? "50000"),

  // Maximum characters to extract from a single PDF (client-side fallback)
  pdfMaxExtractChars: Number(import.meta.env.VITE_PDF_MAX_EXTRACT_CHARS ?? "500000"),

  // Per-doc character budgets for multi-doc prompt assembly
  singleDocBudgetChars: Number(import.meta.env.VITE_SINGLE_DOC_BUDGET_CHARS ?? "90000"),
  twoDocBudgetChars: Number(import.meta.env.VITE_TWO_DOC_BUDGET_CHARS ?? "55000"),
  threePlusDocBudgetChars: Number(import.meta.env.VITE_THREE_PLUS_DOC_BUDGET_CHARS ?? "36000"),

  // UI timing thresholds (ms)
  thinkingHintDelayMs: Number(import.meta.env.VITE_THINKING_HINT_DELAY_MS ?? "8000"),

  // Max chars to show for intermediate doc analysis preview
  docAnalysisPreviewChars: Number(import.meta.env.VITE_DOC_ANALYSIS_PREVIEW_CHARS ?? "3000"),
};
