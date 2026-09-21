export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // DeepSeek — kept as an optional fallback in case MiniMax is unavailable.
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  deepSeekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  // MiniMax is the primary backend model used by the regulatory agent.
  minimaxApiKey: process.env.MINIMAX_API_KEY ?? "",
  minimaxBaseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn",
  minimaxModel: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
  ragAnythingBaseUrl: process.env.RAG_ANYTHING_BASE_URL ?? "",
  ragAnythingApiKey: process.env.RAG_ANYTHING_API_KEY ?? "",
  reportFontPath: process.env.REPORT_FONT_PATH ?? "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Light.otf",
};
