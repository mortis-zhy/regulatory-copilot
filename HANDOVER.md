# 交接文档 — GB 4785 多版本横向对比报告 一站式生成站

> 更新：2026-10-06。旧版本文档（V6/V8 时代、120 页报告、手工 esbuild 命令）已整体过时，
> 全部以本文件为准。

## 0. 这是什么项目

一个 Web 应用，对比三份车灯法规 PDF 并生成一份可直接发给客户的横向对比报告 PDF：

| 标签 | 文档 | 说明 |
|---|---|---|
| **A** | GB 4785 草案 V4.3.5（103p） | 新版草案，中文 |
| **B** | GB 4785-2019（81p） | 现行标准，中文 |
| **C** | UN R48-09（147p） | 欧标，英文 |

核心交付物是报告里的 **§11.3.3 参数对照矩阵**（安装高度/角度/频率/车速等 24 个参数维度
的 A/B/C 三版逐行对照）和 **执行摘要的 4 条决策口径**。客户就是冲这两块买单的。

## 1. 最新交付物（PDF对比 文件夹）

```
C:\Users\zsndz\Desktop\comparison_agent-main\PDF对比\
├─ ①_对比报告_143页_终版.pdf          ← 网站管线产出的基线（143 页，经校准）
├─ ③_网站全新生成_111页_10月5日.pdf    ← 111 页，0 缺失占位，含 §11.3.3 矩阵
├─ ⑤_网站全新生成_122页_v3_终版.pdf    ← v3 版本
├─ 源文件_A_…、源文件_B_…、源文件_C_…  ← 三份源 PDF（上传网站的原始文件）
└─ 争议裁定书.txt
```

**网站当前状态**（2026-10-06）：
- `npm run verify` ✅ **28/28 全绿**（构建清单 / 源码级断言 / verify_claims 完全划分 / 单测）
- `reports/last-report.json`（350KB）：generator=mineru，14 章 + 3 附录，**0 占位符**，
  §11.3.3 矩阵齐全，决策口径 4 条。
- 数据阶段已闭环；**最终 PDF 的浏览器下载在上一会话末未捕获成功**（server.log 里
  `report built` 之后的渲染日志被 cut 掉）。若客户急需，先用 ① 或 ⑤；要最新一版就按下文
  §2 启动站点重新生成/渲染。

## 2. 怎么启动

两个仓库，都是 git：
```
C:\Users\zsndz\Desktop\comparison_agent-main\            ← 外层（工作台/交付物/HANDOVER.md）
└─ comparison_agent-main\                                ← 内层 = 源代码根（npm 工程）
```

```powershell
cd C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main
npm run dev          # tsx watch，起 Web 服务
```

- Web 服务端口：**3000 起，逐个 +1 找空位**（`server/_core/index.ts` 里
  `findAvailablePort`）。3000 被占会退 3001，日志会打
  `Port 3000 is busy, using port 3001 instead`。
- **MinerU sidecar（端口 8300）会自动拉起**：第一次调 `/api/agent/report/generate/mineru`
  时，`ensureSidecar()`（server/_core/sidecarClient.ts）发现 /health 不通就
  detached spawn `python python_service/main.py` 并轮询到可用。不用手动开。
  若自动拉起失败（日志 `[sidecar] auto-start failed`），手动：
  `python python_service/main.py`
- 之前需要一个 `start.ps1`（3000 + 8300 双进程）；现在 sidecar 有守护逻辑，`npm run dev`
  一条命令即可。

## 3. 构建 & 校验

改完 `server/` 或 `client/` 下的源码：

```bash
npm run build      # vite build && node scripts/build-libs.mjs
npm run verify     # 交付前闸门，28 项
```

构建注意：
- `dist/` 是 **gitignored 构建产物，永不手改**。历史上所有“改了 dist 没改源码”的事故都
  以 `npm run build` 静默覆盖收场。唯一例外：`dist/` 里还住着**语料库数据文件**
  （mineru-v4-data.json / extract-cache/ / sidecar-cache/ / verified-comparison.json /
  facts.json），它们不参与构建，但 `scripts/build-libs.mjs` 只写 .js 和
  `.build-manifest.json`，不会碰它们。
- `scripts/build-libs.mjs` 用显式 `{entry, outfile}` 表出 5 个模块：
  `dist/{index, htmlRenderV8, typedTables, reportGenerator, closureLedger}.js`，
  并写 `dist/.build-manifest.json`（各源文件 sha256）。`npm run verify` 第 1 项就是
  重算比对——**改了 .ts 忘 build，闸门直接红**。
- tsconfig target ES5：正则迭代器不能 spread，用 `Array.from(...matchAll(...))`。

`npm run verify` 覆盖：
1. dist 模块存在性 + `.build-manifest.json` 哈希比对
2. 源码级不变量（只 grep .ts/.tsx，**绝不 grep .js**）：下载文件名、cover-eyebrow
   letter-spacing、`emulateMedia({media:"print"})`、`document.fonts` 强制加载等
3. `python verify_claims.py` — extraction→diff→report 三阶段的账目闭环
4. 四个本地单测（`_test_math/_test_impact/_test_table/_test_gap_guard`；
   `_test_exec_retry.mjs` 会打真实 MiniMax，刻意排除在闸门外）
5. 可选：`VERIFY_PDF=…` 时对成品 PDF 做嵌入字体/目录页码检查

## 4. 数据流（一条 MinerU 链路）

```
上传 3 份 PDF
   → POST /api/agent/report/generate/mineru
      ├─ sidecarHealth() || ensureSidecar()        ← 不通就自拉起
      ├─ sidecar /extract → MinerU 4.0.6 结构化抽取（markdown/tables/figures…）
      ├─ sidecar /verify  → verified-comparison.json（numericChanges/topicColumns）
      ├─ buildMinerUReport (server/reports/reportV6.ts)
      │     读 diff-result.json → §11.3.3 参数矩阵 + 执行摘要决策口径
      ├─ renderPdfFromReportV8 (server/reports/htmlRenderV8.ts)
      │     CJK @font-face data-URI + emulateMedia("print") + 两遍渲染回填 TOC
      └─ runDeliveryGate (server/_core/deliveryGate.ts)   ← 6 项「到达读者」检查
            全过 → PDF 落盘 + last-report.json (generator:"mineru")
            不过 → HTTP 422，failures[] 列出每项失败原因
```

- `reports/last-report.json` 带 `"generator": "mineru" | "llm-sse"` 标记；
  `GET /api/agent/report/last?prefer=mineru`（默认）遇到不匹配的来源返回 404 并列出
  可用项，而不是把 LLM 草稿冒充成核验报告返回。
- **执行摘要的那条 SSE/LLM 路线只当快速草稿用**（UI 上按钮已标「快速草稿（未经核验）」），
  交付一律走 MinerU 路线。
- `verify_claims.py` 输出**完全划分**：numeric/same_text/rule_dropped 三桶之和必须等于
  候选总数（当前 45），每个被丢弃的候选都有中文 reason 可复核——不存在静默丢行。

## 5. 交付闸门（deliveryGate.ts，6 项）

写它的原因：`npm run verify` 校验的是内部一致性，连续两次交付翻车都是“结构齐全但数据
没到读者手里”。6 项检查全部来自真实翻过车的缺陷：

1. §11.3.3 参数矩阵行数 ≥ diff-result.json 的 valueDiffs
2. C (UN R48) 每行引用自己的 R48 条款号（防 C 列整列空白）
3. 执行摘要 ≥3 条「本报告的结论（按决策口径）」
4. 附录 C 表头必须命中渲染器版本列白名单（否则三栏卡片全变占位符）
5. 声称“三列原文对照”的章节必须有真 C 行
6. 第 11 章四节（11.2 / 11.3 / 11.3.0 / 11.4）结构性存在

生成端点在 returnPdf 前跑这 6 项，任一失败 → 422 + 每项的中文出错原因。**坏报告从此出
不了服务**，这是本项目的最后一道闸。

## 6. 版本管理

- 内层仓库 `master` 与 `main` 同名共用（`git status` 用哪个都行）。死键会话曾把提交做在
  `main` 上，如 `f42ff85 fix(core): sidecar 自愈守护 + 交付闸 422 接线 + 渲染超时按体量伸缩`；
  后续会话曾把交付闸等提交做在 `master`（`bd8cca2` 等）——**两条分支都在推进**。
- 交接/审计脚本（外层）：`verify_all.ps1`（可选，对源 PDF 做交叉核验）、
  `PDF_READABILITY_DIAGNOSIS.md`、`REPORT_ERRORS.md`。
- 回收站脚本 `_recycle_stale.ps1` 曾把 dist 与 90 个外层文件移进回收站（10-06 21:22），
  已全部恢复；教训写进了 verify.mjs 的头注释。

## 7. 已知 TODO / 风险

| 项 | 状态 |
|---|---|
| 上会话末尾有一批 11:14 起的 node/python 进程组产出未落日志，PDF 未捕获 | 待查（任务 #31） |
| sidecar 首次启动要加载 torch，冷启动 >30s；ensureSidecar 默认等 60s | 一般够用 |
| dist/ 里的语料库 JSON 与 .js 混居 | 长期应迁到独立 data/ 目录（未做） |
| `extract-cache/` 里是 MiniMax 非确定产物（3 次真实调用），**恢复优先于重建** | 已恢复 |
| 内层仓库有若干未追踪的调试脚本（_test_*.mjs / _verify_fonts.py / pages_check/ 等） | 无害，但入库更干净 |

## 8. 调试手册（踩过的坑）

- **PDF 中文变方块** → 字体没嵌入。Chromium headless 不把 @font-face 的 data-URI 字体嵌
  进 PDF，除非 **print media 生效**：`page.emulateMedia({media:"print"})` 必须在
  `setContent` **之前**。渲染后用 `_verify_fonts.py`（pikepdf）确认 Type0 字体 ≥4 且
  带 ToUnicode 的是 0 个。
- **超时 chrome-error://chromewebdata** → 大报告 setContent 120s 不够；现在按
  `html.length/900` 伸缩到 ≤600s（htmlRenderV8.ts，已提交）。
- **TOC 页码是 “—”** → pass1 锚点 `CHPAGEANCHOR###` 没找到；查 `findAnchorPages`。
- **中文文件名进程参数乱码** → Windows argv 编码问题，走 stdin 传 base64。
- **硬编码路径** → 已全部去硬编码：TS 用 `resolve(import.meta.dirname, "../..")`，
  Python 用 `COMPARE_AGENT_ROOT` 环境变量。新增脚本禁止再写 `C:/Users/zsndz`。
- **页面渲染不对先怀疑两件事**：① 是不是改了 dist 忘了 build（verify 第 1 项红）；
  ② Read 工具图片显示缓存与文件不一致——**用 mupdf/像素统计自己验，别信 Read**。
