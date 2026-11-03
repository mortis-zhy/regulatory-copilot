/**
 * 下载文件名：**由服务端给**（`Content-Disposition` / `X-Report-Filename`）。
 *
 * 为什么不在客户端算：
 * 两条下载路径里，只有一条客户端手里有报告对象；
 * 另一条是**服务端**读 `reports/last-report.json` 自己渲染的，
 * 客户端什么都不知道 —— 在客户端算就得写死标准名，
 * 换一套新标准就会下载出一个名字里还写着 GB 4785 的新标准的报告。
 *
 * 所以：**服务端一处派生，两条路都准。**
 */

/**
 * 从响应头取服务端派生的文件名。
 *
 * @param res   fetch 的响应
 * @param ext   扩展名（服务端没给头时的兜底）
 */
export function reportFileNameFromResponse(res: Response, ext: "pdf" | "doc" = "pdf"): string {
  // 自定义头里是**百分号编码**的名字 —— Node 的 HTTP 层拒绝非 ASCII 的 header 值。
  const raw = res.headers.get("X-Report-Filename");
  if (raw && raw.trim()) {
    try {
      return decodeURIComponent(raw.trim());
    } catch {
      /* 落到 Content-Disposition */
    }
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim());
    } catch {
      /* 落到通用名 */
    }
  }
  return `多版本横向对比研究报告.${ext}`;
}
