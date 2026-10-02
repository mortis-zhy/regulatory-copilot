# 交接文档 — GB 4785 多版本横向对比报告 PDF 生成管线

## 1. 最新交付物

```
C:\Users\zsndz\Desktop\comparison_agent-main\
├─ GB4785_多版本横向对比研究报告.pdf        ← 最新报告（3.66 MB · 120 页 · 你应该打开这个）
├─ GB4785_多版本横向对比研究报告_旧版V6备份.pdf  ← V6 旧版（214 页 · 不推荐打开）
├─ HANDOVER.md                              ← 本文件
├─ _FINAL_ACCEPT.txt                        ← 8/8 验收记录
├─ PDF_READABILITY_DIAGNOSIS.md             ← 初期诊断报告（背景）
├─ GB4785_V8_final.pdf                      ← 中间产物（与上面那份内容相同）
├─ _diag_user.txt                           ← 用户反馈的诊断
├─ _test_math.mjs, _test_impact.mjs         ← 单元测试（见 §6）
└─ comparison_agent-main\                   ← 源代码根目录
```

## 2. 项目根目录与运行

```
源代码根：C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\
启动方式：powershell -ExecutionPolicy Bypass -File start.ps1（端口 3000 + 8300）
关键路由：
  POST /api/agent/report/render        ← 当前指向 V8
  POST /api/agent/report/generate      ← SSE 流式生成（含 V8 prompt 改动）
  POST /api/agent/report/generate/mineru   ← MinerU 管线（returnPdf 也走 V8）
```

构建命令（改完代码后必须执行）：
```bash
cd "C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main"
npx esbuild server/reports/htmlRenderV8.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/htmlRenderV8.js
npx esbuild server/_core/index.ts    --platform=node --packages=external --bundle --format=esm --outfile=dist/index.js
```

## 3. 修改过的文件（3 个）

### `comparison_agent-main\server\reports\htmlRenderV8.ts`（主交付物）
全新的 V8 渲染器，替换了原来的 V6 htmlRender.ts。**请作为唯一渲染源**。功能：
- CJK 字体 base64 内联（`@font-face`，data: URI 嵌入 msyh/simhei/SimSun/SimSunExt）
- LaTeX 公式处理（`$...$`、`$$...$$`）— 自实现的 `reduceLatex()`，支持 `\mathrm{...}`、`_{...}`、`\le/\ge/\to/\cdot`、希腊字母
- 表格多行行收集器（`collectTableRows`）— 解决 ch14 长单元格被截断
- 按表头对齐的列映射（条款/页码/正文）— B 在 A 前面也能正确取
- 三栏 triptych 卡片（`renderTriptych`）— 缺失的版本自动输出灰色「源数据未提供」占位卡
- 4 维影响矩阵（`renderImpactMatrix`）— 解析 `🔧 设计影响 / 🧪 测试影响 / 📋 认证影响 / ⚠ 风险等级`
- 变化判定条（`renderVerdict`）— 接受反引号标签或 emoji 标签
- 主参数总表（`renderMasterParams` + `extractMasterParams`）— header-driven，仅收数值型行
- 三版条款·页码映射总表（`renderMappingIndex` + `extractClauseMapping`）— 按主题横向对比
- 部首归一化（`RADICAL_MAP` + `fixRadicals`）— 防止 MinerU 抽取出来的部首字符污染
- **二次渲染回填 TOC 真实页码**（`renderPdfFromReportV8` + `findAnchorPages` 走 mupdf）— pass1 加锚点找位置 → pass2 不带锚点输出干净 PDF

**重要常量**：
- 字体候选列表：`FONT_CANDIDATES`（Windows 优先 msyh/SimSun，Linux 退到 Noto）
- `RADICAL_MAP` — 部首 → 统一汉字映射（约 100 条），范围 `U+2E80-U+2FDF`
- 文档元数据：`DOC_META`（A/B/C 卡片的标签/颜色/底色）
- 章节封面样式：`chapterCover()` 接受 numLabel + title（附录用 `附X`）

### `comparison_agent-main\server\reports\reportGenerator.ts`
只改了第 359–383 行的 `chapterPrompt()` 函数，强制模型：
- 每张对比表输出 A/B/C 三行（缺行写「本版未规定」）
- 每张 triptych 后面输出一段「4 维影响卡」（emoji + 简短描述）

### `comparison_agent-main\server\_core\agentRoutes.ts`
两处替换：`/api/agent/report/render`（line ~392）和 `/api/agent/report/generate/mineru` 的 returnPdf 分支（line ~220），都改成动态 import `renderPdfFromReportV8`。

## 4. 设计决策（为什么这样做）

1. **不依赖外部 KaTeX/MathJax** — Node 端做服务端 reduceLatex，体积小、零网络、可控。
2. **二次渲染找页码** — Chromium footer template 的 `totalPages` 是当前 PDF 总数，但**单次渲染没法知道每个章节落在第几页**。所以：pass1 加白底 2pt 隐藏锚点 → mupdf 搜索每个 anchor 所在页号 → 给 `chapter.page` 赋值 → pass2 不带锚点输出干净 PDF。
3. **缺失版本输出占位卡（不编造数据）** — 用户要求「数据充实正确」，所以宁可显示「源数据未提供」灰色占位，也不能瞎填 C 版内容。
4. **不使用 NFKC** — Python 测试过 NFKC(U+2EDA)→ 仍是 U+2EDA，不会转成「页」。部首归一必须用显式映射表。

## 5. 已知缺陷 / TODO

| 项 | 状态 |
|---|---|
| 附录 B「公式索引（LaTeX 形式）」按设计保留代码样式，不转排版公式 | by design |
| 字体嵌入双倍大小（Type0 5 个字体 base64 化后约 20 MB，CSS 内联） | 可优化为只内联必需字体 |
| setContent 超时设了 120 秒；网络阻塞 / 大文档可能不够 | 监控 |
| Master Param 表只收「参数名 + 至少一列数字」的表；纯文字比较表被过滤 | by design |
| 来源 Markdown 里的 `$...$` 必须**用空格隔开**（`$ W_{1} $` 不能紧贴正文） | prompt 里已要求但 LLM 偶尔会忘 |

## 6. 验证命令（核心）

### 快速冒烟（单测）
```bash
cd "C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main"
node _test_math.mjs     # 验证 math 渲染：0 mathrm / 0 stray $ / 3 个 <sub>
node _test_impact.mjs   # 验证影响卡 + 占位卡 + verdict-strip：9/9
```

### 完整 PDF 渲染
```bash
# 服务要起
curl -X POST -H "Content-Type: application/json" -d @/tmp/last-report.json \
  -o "C:/Users/zsndz/Desktop/comparison_agent-main/GB4785_多版本横向对比研究报告.pdf" \
  http://localhost:3000/api/agent/report/render
# ~60 秒
```

### 8/8 验收（直接对最终 PDF）
```bash
PYTHONIOENCODING=utf-8 python _diag_user.py   # 见 _diag_user.txt
```
验收项：
1. 用户引用的 `${\mathrm` 公式残留 = 0
2. 裸 mathrm 仅在 p89（附录 B）
3. 残留 `$` = 0
4. 部首字符（`⺀-⿟` 范围）= 0
5. 映射表「见下方」作为条款污染 = 0
6. TOC 真实页码（两遍渲染回填）
7. Type0 TTF 字体 ≥ 4
8. ch04 三色卡 / ch14 灰占位（像素断言）

## 7. 调试技巧

- **PDF 文字提取空白** → 字体未嵌入或 Type3。检查 `doc[0].get_fonts()`。
- **`math` 显示字面 `<sub>` 标签** → 99% 是 `esc()` 没包到。检查 `inlineMd()` 顺序。
- **目录页码是 "—"** → pass1 没找到锚点（`findAnchorPages` 返回空）；检查锚点字符串 `CHPAGEANCHOR###` 是否真在 PDF 里。
- **页数比预期多** → Chromium `setContent` 后页面没等 fonts 加载；调高 `await page.evaluate(() => document.fonts?.ready)`。
- **Read 工具显示的图片跟文件内容不一致** → 这是 harness 的显示缓存 bug，**用 `mupdf` 或像素颜色统计自己验**，别信 Read。

## 8. 联系上下文（上一会话回顾）

原始痛点：用户打开 214 页 V6 旧 PDF 发现中文乱码、LaTeX 不渲染、表格对齐差、Type3 字体复制粘贴全是 `��`。

演化路径：
1. V6 → V7：加 CJK 字体嵌入 + KaTeX 渲染 + triptych 卡片（200→113 页）
2. V7 → V8：加 4 维影响卡 + 主参数总表 + 三版映射索引 + 二次渲染回填 TOC 页码（113→120 页）
3. 用户反馈后：加部首归一化 + 映射表占位符过滤 + 写回用户预期文件名（消除 V6 旧文件干扰）

用户对版式的核心要求（未做的事）：**「核心参数三版总表」「核心条款三列对照」「三版章节映射表」「附录 C 版核心条款汇编」**。前 3 个已实现，附录 C 版核心条款汇编**未实现**（如果要加，需要后端在生成阶段聚合 C UN R48 章节为独立附录）。

## 9. 一句话总结

`POST /api/agent/report/render` 走 V8 渲染器 → 自动 base64 嵌入 CJK → 多行表格 → 三栏 triptych + 灰占位 + 4 维影响卡 + 变化判定条 + 主参数总表 + 映射总表 + 部首归一 + 二次渲染回填 TOC 真实页码。输出文件：`GB4785_多版本横向对比研究报告.pdf`。
