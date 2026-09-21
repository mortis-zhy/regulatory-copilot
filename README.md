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

## Document intelligence integration

`server/integrations/ragAnything.ts` sends uploaded document bytes to the configured RAG-Anything endpoint with MinerU and multimodal extraction enabled. The endpoint response is expected to be compatible with the `ParseResult` boundary in `server/ingestion/pipeline.ts`; this keeps the UI and regulatory evidence model independent of the parser implementation.

`server/integrations/deepseek.ts` uses the OpenAI-compatible DeepSeek Chat Completions API and forwards incremental SSE chunks through `/api/agent/chat/stream`. The server prompt requires evidence anchors and separates facts, model inferences, and items requiring human confirmation.

## Design principles

1. A model suggestion is never treated as a final regulatory conclusion without source anchors.
2. Structure mapping is a gate before semantic comparison.
3. Numeric values, units, conditions and exceptions are stored independently from narrative summaries.
4. Official sources are separated from secondary research evidence.
5. Frozen reports are immutable; changed inputs or rules create a new version.

## Scope note

This is an MVP interface and governed data foundation. Production ingestion still requires an approved document parser, file-storage policy, source whitelist, background job strategy, and domain-specific parameter dictionaries.
