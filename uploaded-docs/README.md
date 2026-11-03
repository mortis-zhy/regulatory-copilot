# uploaded-docs/ —— 活的语料，不是运行时副本

这个目录里的三份 PDF 是**管线的原始输入**，**已经随仓库入库**（已跟踪，新克隆即有）。
仓库里有两份同名的路径，是有意的：

| 本目录（管线读这里） | 内容 | 与 `delivery/` 的关系 |
|---|---|---|
| `2173836fae9f1314.pdf` | GB 4785 草案 V4.3.5（103 页）= 版本 **A** | 与 `delivery/PDF对比/源文件_A_GB4785草案V4.3.5_103页.pdf` **sha256 完全相同** |
| `f86e6c7367f24de2.pdf` | GB 4785-2019（81 页）= 版本 **B** | 与 `delivery/PDF对比/源文件_B_GB4785-2019_81页.pdf` **sha256 完全相同** |
| `92b2563197df022a.pdf` | UN R48-09（147 页）= 版本 **C** | 与 `delivery/PDF对比/源文件_C_UN-R48-09_147页.pdf` **sha256 完全相同** |

## 为什么两份都在

- **`uploaded-docs/`** —— 代码读它。路径写死在 8 处（见下），改路径 = 改管线。
  文件名是**内容哈希前 16 位**，不是版本号 —— 版本身份靠**内容指纹**判定
  （草案与 2019 版封面几乎相同，按页数/封面都分不出来）。
- **`delivery/PDF对比/`** —— 人读的交付目录：带可读文件名的**原始依据**，
  交付件和讲稿都引用它。

字节一样 → git 只存**一份 blob**，两条路径共用，仓库不因此变大。

## 谁在读它

```
scripts/clause_split.py              切条款（闸门调用）
scripts/export_clause_index.py       认哪份是哪一版
scripts/read_margin_clause.py        直接按哈希名取
server/reports/parameterMatrix.ts    取值矩阵定位
server/reports/agentTools.ts         查条款原文的兜底
server/_core/agentRoutes.ts          网页上传的落盘位置
verify_claims.py                     差值核验
```

## 网页上传的文件不在版本库里

`.gitignore` 只放行上面这三份 + 本说明。网页端上传的新 PDF 落在同一目录，
但不入库（`uploaded-docs/*` 被忽略，`!` 只放行已知的那几份）。

> 目录空了 → 闸门当场红，不是"安静地给出错结果"。
> 这一点在 `中间文件清单_2026-10-27.md`（B1 档）里记过一次：
> 清理时差点把 `uploaded-docs/` 当成冗余副本回收 —— 它长得像副本，
> 其实是管线直接读的目录。
