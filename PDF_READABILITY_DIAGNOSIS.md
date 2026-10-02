# PDF 可读性 / 乱码问题诊断报告

**对比对象**：
- 🌐 **Web 端（localhost:3000）**：中文渲染清晰完美，无任何乱码
- 📄 **现网导出 PDF（GB4785_多版本横向对比研究报告.pdf，214页，3.1 MB）**：
  - 视觉渲染：基本可读，但有 LaTeX 未渲染、表格列挤压、稀疏页过多
  - **文字提取**：用 PyMuPDF 复制粘贴出 `��汾����Ա��о來` — 典型乱码

---

## 一、关键发现：所有字体都是 Type3

```
Page 1 fonts:
  (4, 'n/a', 'Type3', '', 'F4', '')
  (5, 'n/a', 'Type3', '', 'F5', '')
  ... (total: 65 fonts, 全部 Type3)
Page 50 fonts:
  ... (total: 64 fonts, 全部 Type3)
```

**Type3 字体 = 文字变成"贴图"**。它：
- ❌ 没有 ToUnicode CMap → 任何文字提取工具（PyMuPDF / pdfjs / 复制粘贴）都拿到乱码
- ❌ 没有真正可搜索的字符 → PDF 不能 Ctrl+F
- ❌ 文件偏大、放大锯齿
- ✅ 但**视觉上能正常显示**（因为每个字都画出来了）

**根因**：当前 `htmlRender.ts:373-408` 调用 Playwright/Chromium 时请求的字体
```css
font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
```
在 Windows headless Chrome 环境下，三个候选都未命中（"Noto Sans SC" / "PingFang SC" 系统没装），最后落到系统 fallback 字体并以 Type3 形式嵌入。

---

## 二、视觉层面的问题（截图证据）

| 页 | 问题 | 截图位置 |
|---|---|---|
| 1 | 封面 OK | `pdf_p1.png` |
| 3 | 执行摘要 OK，章节渲染漂亮 | `pdf_p3.png` |
| 5 | 表头"删除"标签占满整列、表格横向排版 OK | `pdf_p5.png` |
| **10** | **整页只有 3 行表格，下方 80% 空白** — 章节内容太薄 | `pdf_p10.png` |
| **50** | **`$\mathrm{R}_{12}$`、`$\mathrm{FR}_{12}$` 等 LaTeX 公式原样输出**，未渲染 | `pdf_p50.png` |
| **100** | **`$\mathrm{M}_{1}$`、`$\mathrm{N}_{1}$`、`$\mathrm{O}_{1}$` 未渲染**；"变化判定"红点单独成行 | `pdf_p100.png` |
| **150** | **满屏 `$\mathrm{A}$`、`$\mathrm{R}$`、`$\mathrm{W}$` 全是 raw LaTeX** | `pdf_p150.png` |
| **200** | 表格列被挤到 **"级别" 被切成 "级 / 别" 两行字**，且内容大量是 LaTeX | `pdf_p200.png` |

**核心问题清单**：
1. **LaTeX 公式（`$...$` / `$\mathrm{...}$`）零处理** — htmlRender.mdToHtml() 完全不知道 KaTeX/MathJax
2. **省略号 `...` 被拆成"、、、`"** — Markdown 反斜杠转义或编码问题
3. **窄列下中文被强制换字** — 表格列宽算法对中文不友好
4. **大量短章节导致页内空白** — 没有"小节并页"逻辑
5. **TOC 页码全是空** — `c.page ?? ""`（htmlRender.ts:213）没回填

---

## 三、对比 Web 端（localhost:3000）

Chrome MCP 截图 `localhost_home.jpeg` 显示 Web 端中文完美渲染，因为：
- 浏览器加载 WebFont 时直接拿到的就是 TTF/OTF **带 ToUnicode CMap 的 TrueType**
- 系统字体"Microsoft YaHei UI"在 GUI Chrome 下能命中

**但同一个 Web 页面如果用 Chrome 走 `--print-to-pdf` 无头打印，还是会变 Type3** — 这是 Chrome headless 模式的通病。

---

## 四、解决方案：从"贴图式 Type3"升级到"真正可搜索 PDF"

### 方案 A（推荐 · 改 htmlRender.ts 的字体策略）

**核心**：让 Chromium 找到一份**带 CMap 的 CJK TTF** 并显式 `@font-face` 注入到 HTML。

```ts
// htmlRender.ts 开头
import fs from "node:fs/promises";

const CJK_FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\msyhbd.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

async function resolveFirstExisting(): Promise<{ path: string; data: Buffer } | null> {
  for (const p of CJK_FONT_CANDIDATES) {
    try {
      const data = await fs.readFile(p);
      return { path: p, data };
    } catch {}
  }
  return null;
}
```

把字体转 base64 嵌入 `<style>`：

```ts
export async function buildHtml(report): Promise<string> {
  const font = await resolveFirstExisting();
  const fontFace = font
    ? `@font-face { font-family: "AppCJK"; src: url("data:font/ttf;base64,${font.data.toString("base64")}") format("truetype"); font-weight: 400; }`
    : "";
  // ... 把 fontFace 插到 <style> 顶部
  // ... body / chapter-body 把 font-family 改成 "AppCJK", "Microsoft YaHei", sans-serif
}
```

**效果**：Chromium 在打印时会用这份 CJK TTF 嵌入，**TrueType + ToUnicode CMap**，可复制、可搜索。

### 方案 B：KaTeX 预处理

在 `mdToHtml()` 之前把 `$...$` / `$$...$$` 走一遍 KaTeX：

```ts
import katex from "katex";
const html = katex.renderToString(latex, { throwOnError: false, displayMode: block });
```

然后把结果内联到 `<span class="math">`。需要新增 `katex` 依赖并改 htmlRender.ts。

### 方案 C：丢掉 Playwright，直接用 pdf-lib + 真 CJK 字体

参考现有 `server/reports/export.ts`（已经在用 pdf-lib + SimHei 嵌入）。优点：
- 完全可控字体嵌入
- Type1/TrueType + 完整 ToUnicode
- 文件更小、更可访问

缺点：要重写 200+ 页长报告的排版（封面/目录/章节/附录/页眉页脚）。

### 方案 D（最简单）：换 Chrome 启动参数 + 关 PDF 标签

```ts
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--font-render-hinting=none",
    "--enable-font-antialiasing",
    "--disable-font-subpixel-positioning",
    "--no-sandbox",
    // 关键：把 CJK 字体目录告诉 Chromium
    "--extra-fonts-dir=C:\\Windows\\Fonts",
  ],
});
```

加上在 HTML 里显式 `@font-face url(file:///C:/Windows/Fonts/msyh.ttc)`。但 Windows headless Chrome 经常无视这条路，所以建议**方案 A + B 组合**。

---

## 五、推荐落地顺序（性价比）

1. **【必做 · 半天】方案 A**：嵌入 CJK 字体到 HTML。修复制粘贴乱码。
2. **【必做 · 半天】方案 B**：KaTeX 渲染 LaTeX 公式。修复 `$\mathrm{R}_{12}$` 这种半成品。
3. **【应做 · 1 天】**：mdToHtml 的中文 ellipsis / 表格列宽 / TOC 页码回填。
4. **【可选 · 2 天】**：从 Playwright 切到 pdf-lib 直接出 PDF（彻底告别 headless Chrome 的字体坑）。

---

## 六、马上可验证

如果想先快速验证方案 A 是否靠谱，可以：

```bash
# 在 dist/server 跑一个最小测试
node -e "
import('playwright-core').then(async ({chromium})=>{
  const b=await chromium.launch({channel:'chrome'});
  const p=await b.newPage();
  const html=\`<style>
    @font-face{font-family:'X';src:url('file:///C:/Windows/Fonts/msyh.ttc')}
    body{font-family:'X','Microsoft YaHei',sans-serif;font-size:30px}
  </style><div>GB 4785 多版本横向对比</div>\`;
  await p.setContent(html);
  await p.pdf({path:'test.pdf'});
  await b.close();
})"
```

然后用 PyMuPDF 提取 `test.pdf` 文字，应当能拿到正确的中文。