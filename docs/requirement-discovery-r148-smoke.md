# R148 完整章节冷启动：真实输入试跑记录

日期：2026-11-13。状态：候选扫描已完成，执行状态 partial；独立人工语义验收尚未执行。

## 源件身份与边界

- 官方发布站点：[EUR-Lex，CELEX 42021X1719](https://eur-lex.europa.eu/eli/reg/2021/1719/oj/eng)。
- [下载 PDF](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:42021X1719)。
- 标题：UN Regulation No 148 — Uniform provisions concerning the approval of light-signalling devices (lamps) for power-driven vehicles and their trailers [2021/1719]。
- 首页标明：Incorporating all valid text up to Supplement 3 to the original version；生效日为 30 September 2021。**不是最新版本声明，也不是 Revision 1 Amendment 2。**
- 这是欧盟官方公报刊载的完整文档化汇编，首页明确提醒：国际公法下仅原始 UN/ECE 文本具有法律效力，并列出 ECE/TRANS/WP.29/2018/157、2019/81、2020/32、2021/45。本次未对这些原始文件逐条核对，不将汇编冒充最新法律状态。
- 本地源件：`tmp/r148-2021-1719.pdf`（下载后未修改）；50 个物理页。
- SHA-256：`13d4d7b54087d81021635326a653428e2a1fcebf2ca5799a1e379d684e472268`。

## 固定范围与运行

处理 PDF 物理页 **11–17**：包含完整第 4 章 `GENERAL TECHNICAL REQUIREMENTS`（4.1 至 4.9）。第 4 章在 p11 开始，4.9 在 p17，随后同页开始第 5 章。

CLI 的范围粒度是物理页，因此 **p17 的第 5 章开头也保留在清点和候选中**，不能把全运行计数称为第 4 章要求数。第 4 章引用的其他章节及附录不在本次解析范围；这些依赖仍需另核，不能宣称完整法规已覆盖。

```sh
python -B scripts/discover_requirements.py --pdf tmp/r148-2021-1719.pdf --version R148-original-supplement3-2021 --pages 11-17 --out tmp/discovery/r148-section4-run1
```

不提供参数表、已知章节映射、人工裁决或独立答案。版本标签由调用者依据首页填写。

## 执行结果与开发侧抽查

- 7 个选中页、43 个范围外页；396 个片段（388 个文本片段），65 个候选。350 个片段关联候选、38 个文本片段未触发候选、8 个非文本片段未支持，抽取失败 0。
- 7 个选中页均登记 unsupported，运行状态 partial（CLI 返回 3）；另记表格上下文 6 处、公式上下文 1 处。这里的 unsupported 是未解析对象记账，不代表整页正文抽取失败。
- 逐条检查全部候选证据引文，均可在指定源页的 PyMuPDF 文本中找到；源 PDF 指纹与上列一致。这只证明文本定位。
- p11 还含第 3 章末尾，首个候选锚点为 3.9；p17 含第 5 章开头。65 不能解释为第 4 章要求总数。
- 开发侧抽查发现 4.5.1 的 “Lamps having been approved ... are deemed being also approved ...” 未触发候选，原文保留在 scanned_without_candidate 台账。这是词法触发的已知漏提，当前实现不支持完整语义要求发现。
- 本地实现复核及 29 个 Python 用例、换标准入口重跑通过；既有完整验证摘要为 189/189（dist/verify-summary.json，2026-11-13T03:44:17.608Z）。未把用例数加到顶层闸门数。
- 运行后四份核心 JSON 指纹、33 份 data JSON 组摘要及 24 份 delivery PDF 组摘要与 notes.md 的运行前记录完全一致。

## 尚未完成的语义验收

- 独立全章逐项答案、独立人工语义验收、人工操作计时尚未完成；不报召回率、正确率或人工节省量。

## 第二次运行与逐条清点（2026-11-13）

完整开发侧清点见 [第 4 章条款检查](requirement-discovery-r148-audit.md)。本轮补充通用的视同批准及交叉引用触发词，未加入任何 R148 条款编号特例。

同一命令改用新输出目录 `tmp/discovery/r148-section4-run2`：候选 68（新增 4.5.1、4.8.9.1、4.8.10）；357 个文本片段关联候选、31 个未触发候选；396 个总片段、8 个未支持对象、0 个抽取错误，状态仍为 partial。全部候选证据再次回源页定位通过。

本轮 Python 30 个用例、换标准入口通过；完整 `npm run verify` 重跑完成，189/189，退出码 0（摘要时间 2026-11-13T05:31:13.269Z）。

尚未触发候选的内容包括标题和父级适用条件；4.7.1.3 的在灯光源要求需要承接 4.7.1 的测量义务。第 4 章导言被合并到 3.9 候选、脚注/页脚混排也仍待解决。本轮没有完成条件继承、引用闭包或图表语义解析，因此不能将 68 个候选解释为完整要求清单。

## 父级证据上下文续轮

同日进一步通用化：整数章标题边界启发式分开了第 4 章导言；候选带父级 `context` 和未核证据。新输出 `tmp/discovery/r148-context-run1`：81 个候选、79 个带上下文，状态仍 partial，全部自身与父级引文可在相应源页定位。4.7.1.3 已进入候选，带 4/4.7/4.7.1 上下文；系统尚未判定这些上下文应如何作为条件继承。新增数量包含标题/上下文线索，不是召回率成绩。32 个 Python 用例通过。
