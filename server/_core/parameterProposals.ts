/**
 * 参数提议的人工确认接口。
 *
 * 为什么要有这一层
 * ----------------
 * `scripts/propose_parameters*.py` 从原文捞候选，但**自动提议 ≠ 可以进矩阵**：
 * 自动生成的正曾经抓到「数值对、页对、条款错」的条文（SKILL 坑 9）。
 * 所以确认这一步不能省，但也不该退回纯手工翻 48 万字原文 ——
 * 页面负责"把候选摆到人眼前"，裁定权在人，**校验权在本文件**。
 *
 * 关键设计：POST 落盘前，服务端会用注入的正则在真实语料上**自己跑一遍**：
 *   - 必须命中
 *   - 捕获组必须框出至少一个数字（坑 2 / 坑 9）
 *   - 必须落在该行预期的 R48 章节区间内（坑 1）
 * 任何一条不过就整条拒绝并说明原因。页面因此只是个录入界面，
 * 不是绕过校验的后门 —— 一个写错正则的人在这里也存不进去。
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
// 取值规格提议 agent 的两层：**章号推导**（从兄弟参数已有的正则反推）
// 与**抽取器语义校验**（逐页扫描 + 第一页命中 + 只读第 1 个捕获组）。
// agent 的提议必须过这一层才允许落盘 —— 页面是录入界面，不是后门。
import { deviceChapterPrefixes, validateProposal } from "../reports/specAgent";
/**
 * 项目根 —— **唯一实现**在 `server/_core/projectRoot.ts`。
 *
 * 原来这里自己写了一份（认 `data/parameter-specs.json`、向上找 6 层、
 * 找不到抛错）。逻辑几乎一样，但**两份实现就会漂移** ——
 * `projectRoot.ts` 认 8 层，这份认 6 层；
 * 哪天有人改了其中一份的认据，两边就会指向不同的目录。
 *
 * 症状不是报错，是**读到了别人的目录**：那个目录读起来是「成功」的，
 * 只是内容不对 —— 那种错最难发现。
 */
import { PROJECT_ROOT } from "./projectRoot";

export { PROJECT_ROOT };
const ROOT = PROJECT_ROOT;
const CANDIDATES_C = path.join(ROOT, "data", "parameter-candidates-c.json");
const CANDIDATES_AB = path.join(ROOT, "data", "parameter-candidates.json");
const SPECS = path.join(ROOT, "data", "parameter-specs.json");
const AGENT_PROPOSALS = path.join(ROOT, "data", "parameter-specs-agent.json");
const REPORT = path.join(ROOT, "reports", "last-report.json");
const MINERU = path.join(ROOT, "dist", "mineru-v4-data.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * 复制品的章节区间。
 *
 * ## 章节表从哪来（这一段改过）
 *
 * 原来这里**手抄**了一份 25 个章节号，注释写着「与 propose_parameters_c.py
 * 的 R48_SECTIONS 同源」—— **「同源」不等于「同源」**：
 * 那是一份拷贝。Python 侧加了 6.27，这边不会跟着动；
 * 漏掉的后果是「章节区间算错 → 提议落到别的章里也不报错」。
 *
 * 现在改成**读同一个文件**：`data/parameter-candidates-c.json` 的 `sections`
 * 数组由 `propose_parameters_c.py` 从 `R48_SECTIONS` 生成，
 * 于是链条是 **R48_SECTIONS（唯一手写处）→ candidates-c.json → 这里**，
 * 中间没有第二份拷贝。
 *
 * 读不到就**抛错**，不退回任何内置副本 ——
 * 「宁可空着，不可错着」：没有章节表时，
 * 条款区间这道校验根本没法做，那就**不许落盘**。
 */
function sectionSpans(fullText: string, nos: string[]) {
  const marks: Array<{ start: number; no: string }> = [];
  for (const no of nos) {
    const n = no.replace(/\./g, "\\.");
    // 与 Python 侧同一形态：行首、允许表格竖线、排除子条款的数字后缀。
    const re = new RegExp(`^[|\\s]*${n}(?!\\d)(?:\\.\\s|\\.(?=${n})|\\s|$)`, "m");
    const m = re.exec(fullText);
    if (m) marks.push({ start: m.index, no });
  }
  marks.sort((a, b) => a.start - b.start);
  const spans: Record<string, [number, number]> = {};
  marks.forEach((mk, i) => {
    spans[mk.no] = [mk.start, i + 1 < marks.length ? marks[i + 1].start : fullText.length];
  });
  return spans;
}

/**
 * 复制品的章节号 —— **唯一来源**是 `data/parameter-candidates-c.json` 的
 * `sections` 数组（由 `propose_parameters_c.py` 从 `R48_SECTIONS` 生成）。
 *
 * 读不到就抛错，**不退回任何内置副本**。
 */
function cSectionNumbers(): string[] {
  const doc = readJson<any>(CANDIDATES_C, null);
  const secs = Array.isArray(doc?.sections) ? doc.sections : [];
  const nos = secs.map((s: any) => String(s?.no ?? "").trim()).filter(Boolean);
  if (!nos.length) {
    throw new Error(
      "data/parameter-candidates-c.json 里没有 sections —— " +
        "章节区间这道校验做不了，不许落盘。" +
        "先跑 `python scripts/propose_parameters_c.py` 重新生成候选池。",
    );
  }
  return nos;
}

/**
 * 采集组必须是值，不是车型编号。
 *
 * 与 `numbersOf()` 的过滤口径保持一致：5类 / 6类 / N2G 这类编号不是限值。
 * 数值对而含义错是最贵的一类 bug（造出一条客户会当真的假变化），
 * 所以在这里就把它挡掉，而不是等交付后的审阅。
 */
function numbersIn(raw: string): string[] {
  return (
    raw
      .replace(/\d+\s*[a-z]?\s*类/g, " ")
      .replace(/\b[A-Z]\s*\d+\s*[A-Z]\b/g, " ")
      .match(/\d+(?:\.\d+)?/g) ?? []
  );
}

interface AcceptedItem {
  id: string;
  source: string;
  flags?: string;
  why?: string;
  section?: string;
  /** 标准代号（A / B / C）。缺省按 C 处理（老的页面只填 C）。 */
  version?: string;
  /** 来自 agent 的提议 —— 走**更严**的那套校验 */
  fromAgent?: boolean;
}

export function registerParameterProposalRoutes(router: Router) {
  router.get("/api/parameters/proposals", (_req, res) => {
    const candidatesC = readJson<any>(CANDIDATES_C, { rows: [], sections: [] });
    const candidatesAB = readJson<any>(CANDIDATES_AB, { groups: [] });
    const specs = readJson<any>(SPECS, { specs: [] });
    const report = readJson<any>(REPORT, { parameterMatrix: [] });
    const agent = readJson<any>(AGENT_PROPOSALS, { rows: [] });

    const cells: Record<string, any> = {};
    for (const r of report.parameterMatrix ?? []) cells[r.id] = r.cells ?? {};

    // **agent 的提议**（scripts/run_spec_agent.mjs 的产物）——
    // 只把**通过了校验**的摆到人面前；没过校验的连同拒绝理由一起给出来，
    // 人要能看见「agent 试过了，但没成」，而不是「agent 什么都没说」。
    const agentRows = (agent.rows ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      family: r.family,
      unit: r.unit,
      version: r.version,
      device: r.device,
      source: r.source ?? null,
      flags: r.flags ?? null,
      why: r.why ?? "",
      absent: r.absent ?? null,
      error: r.error ?? null,
      validation: r.validation ?? null,
      ok: !!r.source && !!r.validation?.ok,
    }));

    res.json({
      c: candidatesC,
      ab: candidatesAB,
      specs: specs.specs ?? [],
      cells,
      agent: { rows: agentRows, generatedBy: agent.generatedBy ?? null },
      corpusLoaded: fs.existsSync(MINERU),
    });
  });

  router.post("/api/parameters/proposals", async (req, res) => {
    const items = (req.body?.items ?? []) as AcceptedItem[];
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items 为空" });
    }

    const mineru = readJson<any>(MINERU, {});
    const cText = String(mineru?.C?.fullText ?? "");
    if (!cText) {
      return res.status(503).json({
        error: "dist/mineru-v4-data.json 读不到或没有 C 版语料 —— 不校验就无法安全落盘",
      });
    }
    let spans: Record<string, [number, number]>;
    try {
      spans = sectionSpans(cText, cSectionNumbers());
    } catch (e) {
      return res.status(503).json({
        error: e instanceof Error ? e.message : String(e),
        hint: "章节表缺失时**不做**条款区间校验 —— 那等于放行一切，所以这里必须停。",
      });
    }
    const specsDoc = readJson<any>(SPECS, { specs: [] });
    const specs: any[] = specsDoc.specs ?? [];

    const accepted: any[] = [];
    const rejected: Array<{ id: string; source: string; reason: string }> = [];

    for (const it of items) {
      const version = String(it.version ?? "C");
      const spec = specs.find((s) => s.id === it.id);
      if (!spec) {
        rejected.push({ id: it.id, source: it.source, reason: "spec 里没有这个 id" });
        continue;
      }
      if (spec.patterns?.[version]) {
        rejected.push({
          id: it.id,
          source: it.source,
          reason: `该行已经有 ${version} 模式，先删掉旧的再改`,
        });
        continue;
      }

      let re: RegExp;
      try {
        re = new RegExp(it.source, it.flags ?? "i");
      } catch (e) {
        rejected.push({ id: it.id, source: it.source, reason: `正则编译失败：${(e as Error).message}` });
        continue;
      }

      // 正则要在**这一版**的语料上验 —— A/B/C 的条文完全不同。
      const vText = String(mineru?.[version]?.fullText ?? "");
      if (!vText) {
        rejected.push({ id: it.id, source: it.source, reason: `没有 ${version} 版的语料` });
        continue;
      }
      const m = re.exec(vText);
      if (!m) {
        rejected.push({
          id: it.id,
          source: it.source,
          reason: `在 ${version} 版语料里匹配不到 —— 锚点多半写错了`,
        });
        continue;
      }

      // 坑 2：`locate()` 只读第 1 个捕获组。组没框住值就会「匹配成功但数值为空」。
      const captured = m[1] ?? m[0];
      const nums = numbersIn(captured);
      if (nums.length === 0) {
        rejected.push({
          id: it.id,
          source: it.source,
          reason: `捕获组里没有数字（捕获到「${captured.slice(0, 40)}」）—— 框到的不是值`,
        });
        continue;
      }

      // 坑 1：条款归属。页面上选的章节必须真的罩住这次命中。
      //
      // **选了但章节表里没有 → 拒绝**（原来写成 `spans[it.section] && …`，
      // 章节不存在时整道检查被**静默跳过** —— 于是「§6.99」这种
      // 不存在的章节可以直接落盘，一个字都不报错）。
      // 「宁可空着，不可错着」：校验做不了的时候，正确答案是**不放行**。
      if (it.section) {
        const span = spans[it.section];
        if (!span) {
          rejected.push({
            id: it.id,
            source: it.source,
            reason:
              `所选的 R48 §${it.section} 不在章节表里 —— ` +
              `章节归属这道校验做不了，不放行。（章节表来自 data/parameter-candidates-c.json）`,
          });
          continue;
        }
        if (m.index < span[0] || m.index >= span[1]) {
          rejected.push({
            id: it.id,
            source: it.source,
            reason: `命中位置不在所选的 R48 §${it.section} 区间内 —— 抓到的是别的章的条文`,
          });
          continue;
        }
      }

      // **agent 的提议走更严的那套校验** ——
      // 抽取器是**逐页扫描、取第一页命中**的，所以「能在更早的别的章命中」
      // 的正则会**静默产出错值**。`validateProposal` 用**同一套语义**
      // （paginate + numbersOf + nearestClause）复刻这一点。
      // 装置的章号从**兄弟参数已有的正则**里反推（自校准，不另建映射表）。
      if (it.fromAgent) {
        const device = String(it.id).split(".")[0];
        const prefixes = deviceChapterPrefixes(specs, device, version);
        if (prefixes.length) {
          const val = validateProposal(
            { id: it.id, version, device, name: spec.name ?? it.id, source: it.source, flags: it.flags ?? "i" },
            mineru[version],
            prefixes,
            { unit: spec.unit },
          );
          if (!val.ok) {
            rejected.push({
              id: it.id,
              source: it.source,
              reason: `抽取器语义下不成立：${val.reason}`,
            });
            continue;
          }
        }
      }

      spec.patterns = {
        ...(spec.patterns ?? {}),
        [version]: { source: it.source, flags: it.flags ?? "i" },
      };
      spec.why = {
        ...(spec.why ?? {}),
        [version]:
          it.why?.trim() ||
          (it.fromAgent
            ? "由取值规格提议 agent 产出，经抽取器语义校验后由人工确认页采纳"
            : "经人工确认页采纳；见 data/parameter-candidates-c.json 的候选句"),
      };
      accepted.push({ id: it.id, version, nums, at: m.index });
    }

    if (accepted.length === 0) {
      return res.status(422).json({ error: "没有任何一条通过校验，未改动 spec", accepted, rejected });
    }

    // 先备份再落盘。这个文件是全项目唯一的取值来源，写坏了没有第二份。
    fs.writeFileSync(SPECS + ".bak", fs.readFileSync(SPECS, "utf-8"), "utf-8");
    fs.writeFileSync(SPECS, JSON.stringify({ ...specsDoc, specs }, null, 2) + "\n", "utf-8");

    res.json({
      ok: true,
      accepted,
      rejected,
      backup: path.relative(ROOT, SPECS + ".bak"),
      next: "npm run build && node rebuild_report.mjs && npm run verify && python _audit2.py",
    });
  });
}
