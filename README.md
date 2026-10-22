# Regulatory AI · 法规智能对比平台

面向企业法规、标准和技术规范管理的通用网页端 Agent MVP。平台按照“结构对齐 → 内容对比 → 专业参数 → 联网证据 → 人工审核 → 版本报告”的顺序工作，目标是让法规变化从一次性人工整理，变成可复用、可追溯、可审计的企业能力。

## Current MVP

- Executive dashboard with project, document, review, research, report, and governance views.
- Generic project, document, clause, mapping, comparison, change, evidence, and report data model in Drizzle.
- tRPC procedures for platform counts, projects, documents, changes, evidence, project creation, and change review.
- Review workbench with source/target excerpts, confidence, severity, evidence, and human review actions.
- Pluggable document-ingestion adapter boundary for native parsing, MinerU, and RAG-Anything-compatible multimodal parsing.
- Version-aware report and evidence governance UI.
- Conversation-first Agent UI with DeepSeek-compatible SSE streaming.
- **取证型 agent**（`/api/agent/chat/agent`）：模型自己调**只读**回源工具
  （查条款原文、查引文在哪一页、查覆盖台账、查差值判定），
  每个事实都带源 PDF 的页码；查不到就如实说查不到。
  网页端有「取证模式（回源核验）」开关 + 可展开的「取证记录」，
  让用户看得见 agent 到底查了什么。
- Real file upload to object storage followed by RAG-Anything/MinerU parsing.
- Difference table with old/new highlighting, source-location actions, parameter CSV export, and Word/PDF report downloads.

## Run locally

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm dev
```

The application is built with React, Tailwind CSS, Express, tRPC, Drizzle and MySQL/TiDB. Auth, storage and built-in service configuration are supplied by the Manus WebDev runtime; do not commit `.env` files or credentials.

See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for DeepSeek, RAG-Anything, storage and PDF font configuration.

## 交付闸门

```bash
npm run verify     # 82 项检查 —— 交付前必跑
```

闸门不依赖标准是什么：取值能回到源 PDF 的某一页的某一句、要求要么在台账上
要么有登记的不适用理由、每一条「原文里没有」都附**查过哪里**的依据、
附录 D 的条款号查得到、agent 的取证链完整。

`_test_agent_e2e.mjs` 调真模型验证「查得到要带页码、查不到不许编页码」，
费钱且会抖，所以**不进闸门**，但要人工定期跑。

## Document intelligence integration

`server/integrations/ragAnything.ts` sends uploaded document bytes to the configured RAG-Anything endpoint with MinerU and multimodal extraction enabled. The endpoint response is expected to be compatible with the `ParseResult` boundary in `server/ingestion/pipeline.ts`; this keeps the UI and regulatory evidence model independent of the parser implementation.

`server/integrations/deepseek.ts` uses the OpenAI-compatible DeepSeek Chat Completions API and forwards incremental SSE chunks through `/api/agent/chat/stream`. The server prompt requires evidence anchors and separates facts, model inferences, and items requiring human confirmation.

`server/reports/agentTools.ts` 是取证 agent 的**唯一证据来源** ——
7 个只读工具全部回源到源 PDF 或报告里已核验的结构化数据。
`server/reports/agentLoop.ts` 是工具调用循环：模型返回 `tool_calls` → 执行 →
结果回灌 → 继续；工具轮用尽后有一轮**收口轮**（撤掉 `tools`，只问结论），
保证这个循环一定以一段可读的回答收尾。

> MiniMax 的 OpenAI 兼容层有两处不按 OpenAI 规范来（`tool_choice:"none"`
> 会把工具调用写成正文里的文本标记；`messages` 里塞裸字符串会回 400
> 且只在下一轮显现）—— 细节都写在 `agentLoop.ts` 的注释里。

## Design principles

1. A model suggestion is never treated as a final regulatory conclusion without source anchors.
2. Structure mapping is a gate before semantic comparison.
3. Numeric values, units, conditions and exceptions are stored independently from narrative summaries.
4. Official sources are separated from secondary research evidence.
5. Frozen reports are immutable; changed inputs or rules create a new version.

## Scope note

This is an MVP interface and governed data foundation. Production ingestion still requires an approved document parser, file-storage policy, source whitelist, background job strategy, and domain-specific parameter dictionaries.
