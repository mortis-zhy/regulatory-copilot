/**
 * 仓库根 —— **唯一实现**在 `server/_core/projectRoot.ts`。
 *
 * ## 这里原来有什么，以及为什么被删掉
 *
 * 原来这个文件是「共享模块」，注释里写着：
 *
 * > Sharing it matters: two copies of this function drift.
 * > The second copy is where the §11.9 bug came from.
 *
 * 说得对。但**它自己就是那第二份**的来源 ——
 * 写完这句话之后，又多出了三份各自为政的解析器：
 *
 * | 位置 | 认据 | 认 `COMPARE_AGENT_ROOT` 吗 | 找不到时 |
 * |---|---|---|---|
 * | `server/_core/projectRoot.ts` | `data/parameter-specs.json` | ✅ | 抛错 |
 * | **本文件**（原样） | `verify_claims.py` | ✅ | **退回 `../..`**（打包后会跑到外层仓库） |
 * | `server/_core/deliveryGate.ts` | `verify_claims.py` | ❌ **不认** | 退回 `../..` |
 * | `server/_core/parameterProposals.ts` | `data/parameter-specs.json` | ✅ | 抛错 |
 *
 * 症状不是报错，是**读到了别人的目录**：
 * 那个目录读起来是「成功」的，只是内容不对 —— 那种错最难发现。
 * 历史上已经因此出过四次静默降级（§11.3.3 矩阵空、书签丢失、TOC 中止、§11.9 缺清单）。
 *
 * 所以现在这里**只做转发**：一份实现、一处认据、一处环境变量。
 * 认据统一用 `data/parameter-specs.json`（数据源层的锚点）——
 * 它与 `verify_claims.py` 在同一个目录，两种用途都覆盖得到。
 *
 * `resolveInnerRoot` 这个名字保留下来：调用方（reportV6 / qualitativeObligations）
 * 不用改，而闸门会盯住「除 projectRoot.ts 外不许再有第二份」。
 */
export { findProjectRoot as resolveInnerRoot } from "../_core/projectRoot";
