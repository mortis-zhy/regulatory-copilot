# 环境配置说明

本项目已将法规智能体的真实能力拆为三个服务边界：**对象存储**负责保存原始法规文件，**RAG-Anything / MinerU 服务**负责解析章节、表格、图片、公式、引用和知识图谱，**MiniMax**负责多轮对话、结构化判断和流式回答。请将真实密钥写入部署环境或 `.env`，不要提交到 GitHub。

## 必填配置

| 变量 | 示例 | 说明 |
|---|---|---|
| `MINIMAX_API_KEY` | `sk-cp-...` | MiniMax API 密钥（仅在服务端使用） |
| `MINIMAX_BASE_URL` | `https://api.minimax.cn` | MiniMax OpenAI 兼容接口地址 |
| `MINIMAX_MODEL` | `MiniMax-M3` | 当前默认模型；如需切换可改成 `MiniMax-M2.7`、`MiniMax-M2.7-highspeed` 等 |
| `RAG_ANYTHING_BASE_URL` | `http://rag-service:8000` | 企业知识治理 / RAG-Anything 服务地址 |
| `RAG_ANYTHING_API_KEY` | `replace-me` | RAG 解析服务密钥 |

> 注：原 `DEEPSEEK_*` 变量保留为可选回退路径。MiniMax 不可用时，代码会回退到 DeepSeek；两者都未配置时，UI 会显示"大模型未配置"且不会伪装成已完成的分析。

## WebDev 已提供配置

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | MySQL/TiDB 连接地址 |
| `BUILT_IN_FORGE_API_URL` | Manus 对象存储代理地址 |
| `BUILT_IN_FORGE_API_KEY` | Manus 对象存储服务密钥 |
| `JWT_SECRET` | 登录会话签名密钥 |
| `VITE_APP_ID`、`OAUTH_SERVER_URL` | Manus 登录配置 |

## 可选配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REPORT_FONT_PATH` | `/usr/share/fonts/opentype/noto/NotoSansCJKsc-Light.otf` | PDF 中文字体路径；生产容器应安装或挂载 CJK 字体 |

## RAG-Anything 解析接口约定

项目的 `POST /api/agent/documents` 接收浏览器上传的 Base64 文件，先写入对象存储，再向 `${RAG_ANYTHING_BASE_URL}/v1/parse` 发送 JSON：

```json
{
  "file_name": "GB-4785-draft.pdf",
  "mime_type": "application/pdf",
  "content_base64": "...",
  "parser": "mineru",
  "multimodal": true,
  "extract": ["hierarchy", "tables", "figures", "equations", "citations", "knowledge_graph"]
}
```

服务应返回与 `server/ingestion/pipeline.ts` 中 `ParseResult` 兼容的 JSON，至少包含 `blocks`、`warnings`、`coverage`、`parser` 和 `parserVersion`。每个 block 应尽量提供 `stableKey`、章节层级、页码、正文、bbox 和解析置信度，以便前端实现原文定位和高亮。

## MiniMax 流式接口

项目的 `POST /api/agent/chat/stream` 会将对话转发到 `${MINIMAX_BASE_URL}/v1/chat/completions`，请求参数使用 OpenAI 兼容格式并设置 `stream: true`、`thinking.type: "adaptive"`。前端按 SSE 渲染：
- `data: {"content": "..."}` → 增量正文
- `data: {"reasoning": "..."}` → 思考过程（仅作"提取中"指示）
- `data: {"done": true}` → 流结束
- `data: {"error": "..."}` → 流异常

服务端系统提示词要求 MiniMax-M3 区分原文事实、模型推断和待人工确认事项；模型内部的 `<think>…</think>` 块会在服务端剔除，不会污染用户答案。

## 启动前检查

```bash
# 复制并按需修改
cp .env.example .env
# 必填：MINIMAX_API_KEY（其它按需）
pnpm check
pnpm test
pnpm build
pnpm dev
```

如果没有配置 MiniMax，界面会显示"大模型未配置"而不会伪装成已完成的分析；如果没有配置 RAG-Anything，文件仍会进入对象存储，但解析状态会显示为"待配置解析服务"。
