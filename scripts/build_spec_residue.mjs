/**
 * **残余台账**的生成器 —— `data/spec-residue.json` 的**唯一**写者。
 *
 * ## 残余是什么
 *
 * 机器判不了的那些槽位。**残余是产物，不是事故** ——
 * 换一套标准时，人的工作量就等于这份清单。
 *
 * 按**病因**分档（治法不同，分档才有用）：
 *
 * | 档 | 病因 | 机器能不能重试 | 上限 | 谁看 |
 * |---|---|---|---|---|
 * | **R1** | 机器试了但没成（校验没过 / 口径对不上 / 章号未知 / 候选为空） | **能**（把理由回灌 agent） | 30 | 批量抽检 |
 * | **R2** | 「这一格到底有没有值」要人裁（agent 判 absent，或与人工结论相反） | 否 | 16 | **逐条人核** |
 * | **R3** | 机器认的章与**人的背书**不一致 | 否（归 W1 修） | **0** | 回 W1 修 |
 *
 * R2 是最危险的一档：**漏一个值 = 矩阵少一格 = 错着说没有**；
 * 反过来（agent 说有值、人工说没有）就是**编造法规**。
 *
 * ## 为什么单独一个文件
 *
 * 三段分离：**提议**（`data/parameter-specs-agent.json`）
 * → **判定**（校验层，结果在提议文件里）
 * → **残余**（本文件）→ **已采纳**（`data/parameter-specs.json`）。
 *
 * 同一条槽位**不许同时出现在两个文件里** —— 闸门守着。
 *
 * ## 用法
 *
 * ```
 * node scripts/build_spec_residue.mjs           # 重出 data/spec-residue.json
 * node scripts/build_spec_residue.mjs --check   # 闸门用：现算 vs 入库，不一致就退出非零
 * ```
 *
 * **检查器不许写产物** —— `--check` 只比对，不写。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPECS = path.join(ROOT, "data", "parameter-specs.json");
const AGENT = path.join(ROOT, "data", "parameter-specs-agent.json");
const MAP = path.join(ROOT, "data", "device-chapter-map.json");
const OUT = path.join(ROOT, "data", "spec-residue.json");

/** 各档的上限（闸门按这个数判）。 */
export const CAPS = { R1: 30, R2: 16, R3: 0, total: 60 };

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

/**
 * 「产物声明」—— 项目统一的形状。
 *
 * **源 PDF 一换，产物立刻作废**（指纹变了）；
 * 换个 prompt 跑出来的结果**分得清**（`_promptVersion`）；模型换了也**看得见**。
 */
function productHeader() {
  let sha = "unknown";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    /* 不是 git 仓库也不该崩 */
  }
  const index = readJson(path.join(ROOT, "data", "clause-index.json"), {});
  const sourceSha = {};
  for (const [v, info] of Object.entries(index._sourcePdfs ?? {})) {
    sourceSha[v] = info?.sha256 ?? "";
  }
  return {
    _generator: `scripts/build_spec_residue.mjs @ ${sha}`,
    _model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
    _promptVersion: process.env.SPEC_AGENT_PROMPT_VERSION ?? "spec-agent/2026-11-06",
    _sourceSha256: sourceSha,
    _builtAt: new Date().toISOString(),
  };
}

/**
 * 从 agent 的输出里推出残余。
 *
 * **已经解决的槽位不算残余** —— 提议文件里那些「校验通过」的提议，
 * 下一段（W3）会被批量采纳；它们不是残余。
 */
export function deriveResidue({ specs, agentRows, chapterMap }) {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const disagreements = new Set(
    (chapterMap?._residue?.machineDisagreements ?? []).map(
      (d) => `${d.device}@${d.version}`,
    ),
  );
  const noChapter = new Set(
    (chapterMap?._residue?.devicesWithoutChapter ?? []).map(
      (d) => `${d.device}@${d.version}`,
    ),
  );

  const rows = [];
  for (const r of agentRows ?? []) {
    const key = `${r.id}@${r.version}`;
    const spec = byId.get(r.id);
    // **已采纳的槽位不是残余** —— 它已经在 `parameter-specs.json` 里了。
    if (spec?.patterns?.[r.version]) continue;

    const push = (grade, basis, similarity) => {
      rows.push({
        id: r.id,
        version: r.version,
        grade,
        basis,
        similarity,
        adjudicated: false,
      });
    };

    // R3：机器认的章与人的背书不一致 —— **不允许有**
    if (disagreements.has(`${r.device}@${r.version}`)) {
      push("R3", `章号与手写 spec 反推的不一致（${r.device}@${r.version}）`, 0);
      continue;
    }
    // R2：「这一格到底有没有值」要人裁
    if (r.kind === "disagrees-has-value") {
      push(
        "R2",
        `agent 认为这一版**有值**（${JSON.stringify(r.validation?.nums ?? [])} @ §${r.validation?.clause}），` +
          `而人工核验的结论是「该版无此规定」—— 编造法规，必须逐条人核`,
        0.5,
      );
      continue;
    }
    if (r.kind === "says-absent" || (r.absent && !r.absentReason)) {
      push(
        "R2",
        `agent 判定「该版无此规定」（${String(r.absent).slice(0, 100)}）—— ` +
          `这一格到底有没有值要人核（漏一个值 = 矩阵少一格 = 错着说没有）`,
        0.5,
      );
      continue;
    }
    // R1：机器试了但没成 —— 可以重试
    if (r.comparatorNote) {
      push("R1", r.comparatorNote, 0.5);
      continue;
    }
    if (r.error) {
      push("R1", String(r.error).slice(0, 200), 0);
      continue;
    }
    if (!r.absent && !(r.validation?.ok && r.source)) {
      push(
        "R1",
        r.validation?.reason ??
          (noChapter.has(`${r.device}@${r.version}`)
            ? "章号未知（这个装置住在哪一章还没定）"
            : "没有产出正则，也没有判定「该版无此规定」"),
        r.validation?.nums?.length ? 0.4 : 0,
      );
      continue;
    }
  }
  return rows;
}

function build() {
  const specs = readJson(SPECS, { specs: [] }).specs ?? [];
  const agent = readJson(AGENT, { rows: [] });
  const chapterMap = readJson(MAP, {});
  const rows = deriveResidue({ specs, agentRows: agent.rows ?? [], chapterMap });
  return {
    _comment:
      "**残余台账** —— 机器判不了的那些槽位。残余是**产物**，不是事故。" +
      "R1 可以让机器重试；R2 必须逐条人核；R3 不允许有。" +
      "人工裁决另存 data/spec-residue-adjudications.json。",
    ...productHeader(),
    _caps: CAPS,
    rows,
  };
}

function main(argv) {
  const doc = build();
  if (argv.includes("--check")) {
    const old = readJson(OUT, null);
    if (!old) {
      console.log("[spec-residue] 入库那份不存在：跑 node scripts/build_spec_residue.mjs");
      return 1;
    }
    // 生成时刻与 git sha 每次不同 —— 比内容，不比这两样
    const strip = (o) => {
      const c = { ...o };
      delete c._builtAt;
      delete c._generator;
      return JSON.stringify(c, null, 1);
    };
    if (strip(old) !== strip(doc)) {
      console.log("[spec-residue] 入库那份**过期**了（agent 跑过了或 spec 变了）");
      console.log("  重出：node scripts/build_spec_residue.mjs");
      return 1;
    }
    const byGrade = {};
    for (const r of doc.rows) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
    console.log(
      `[spec-residue] 与当前状态一致：${doc.rows.length} 条残余` +
        Object.entries(byGrade)
          .sort()
          .map(([g, n]) => ` ${g} ${n}`)
          .join(" ·"),
    );
    return 0;
  }
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n", "utf-8");
  const byGrade = {};
  for (const r of doc.rows) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
  console.log(
    `[spec-residue] 写到 ${path.relative(ROOT, OUT)}：${doc.rows.length} 条残余` +
      Object.entries(byGrade)
        .sort()
        .map(([g, n]) => ` ${g} ${n}`)
        .join(" ·"),
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
