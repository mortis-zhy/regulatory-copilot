/**
 * **渲染用的浏览器从哪来** ✓ —— 一处实现 ✓。
 *
 * ## 为什么不再写死 `channel: "chrome"`
 *
 * 公司服务器上**只有 Edge，没有 Chrome** ✓（实测 2026-11-19：`chrome=False`、`edge=True` ✓）。
 * 写死 `channel:"chrome"` ⇒ 那台机器上**渲染直接失败** ✗
 * （而交付件里 328 页 PDF 全靠它 ✓ —— 失败就是「出不了交付件」✗）。
 *
 * ## 三档（优先级从高到低）
 *
 * 1. `PLAYWRIGHT_EXECUTABLE_PATH` —— 指到**具体可执行文件** ✓（最明确 ✓）；
 * 2. `PLAYWRIGHT_CHANNEL` —— 通道名（`msedge` / `chrome` / `chromium`）✓；
 * 3. 都没有 ⇒ 回到 `chrome` ✓（开发机默认 ✓）。
 *
 * **服务器上要配的一行**（Windows）：
 * ```
 * PLAYWRIGHT_CHANNEL=msedge
 * ```
 */
export type BrowserLaunchOptions = {
  channel?: string;
  executablePath?: string;
  args?: string[];
};

export function browserLaunchOptions(): BrowserLaunchOptions {
  const exec = (process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? "").trim();
  if (exec) return { executablePath: exec, args: ["--no-sandbox"] };
  const channel = (process.env.PLAYWRIGHT_CHANNEL ?? "").trim();
  return { channel: channel || "chrome" };
}
