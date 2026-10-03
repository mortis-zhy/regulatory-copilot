# baseline/ — 已校准基线快照

## 这是什么

`GB4785_V8.6_139p_calibrated.pdf` 是**目前唯一一份通过完整数据校核的产物**。

- 139 页 · 4,348,029 字节
- `verify_pipeline.py` 45 项检查：**43 通过 / 0 失败 / 2 告警**
- 关键结论：3 条双源核验实质变更 · 9 条同文假差异 · 9 条网传指标证伪
- 生成自 `last-report.json`（`generatedAt: 2026-09-29T12:53:55.939Z`）

## 为什么单独备份

这份报告里的**已核验标记、页码 √、勘误降级依据**是 2026-09-29 那次生成时
逐条核对源 PDF 得到的。重跑 `/api/agent/report/generate` 会覆盖
`comparison_agent-main/reports/last-report.json`，这些人工校核痕迹会丢失。

## 恢复方式

```bash
cd C:\Users\zsndz\Desktop\comparison_agent-main

# 恢复报告 JSON
cp baseline/last-report_V8.6_calibrated.json \
   comparison_agent-main/reports/last-report.json

# 恢复 PDF（可选，直接重新渲染更快）
cp baseline/GB4785_V8.6_139p_calibrated.pdf \
   GB4785_多版本横向对比研究报告.pdf
```

恢复 JSON 后直接调渲染端点即可复现出同样的 139 页（渲染是纯函数，
同一份 JSON → 同一份 PDF，已验证 md5 一致）：

```bash
curl -X POST -H "Content-Type: application/json" \
     -d @comparison_agent-main/reports/last-report.json \
     -o GB4785_多版本横向对比研究报告.pdf \
     http://localhost:3000/api/agent/report/render
```

## 相关校验记录

| 文件 | 内容 |
|---|---|
| `verify_report.json` | 45 项校核的结构化结果（运行时生成，未纳入本目录） |
| `../verify_report.md` | 同上，人读版 |
| `../robustness_test.mjs` | 渲染器对陌生数据形状的鲁棒性测试（6/6 通过） |

## 快照时点

2026-10-03 · tag `v8.7.0`（内层代码仓库）