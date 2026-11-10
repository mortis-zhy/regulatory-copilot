/**
 * 任务隔离的用例（同事 issue #2 完成标准 1 与 2）。
 *
 * 判据**问行为**，不判源码里的一行字 ✓ ——
 * 判字面量的闸门会**逼着人把实现改回去** ✗。
 *
 * ① 两个任务的报告**互不覆盖** ✓
 * ② 报告按任务**分目录** ✓
 * ③ 取证结果带**证据范围**（任务 id + 案例包 + 源文件）✓
 * ④ 案例包**不适用**时取证**不回答** ✓（而不是拿别的标准的数据糊弄）
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  sanitizeTaskId,
  taskIdOf,
  taskReportFile,
  resolveReportFile,
  appendTaskUpload,
  readTaskUploads,
} from "./dist/taskContext.js";
import { runAgentTool } from "./dist/agentTools.js";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

const TMP = "reports/tasks/_test_isolation";

// ─────────────────────────────────────────────────────────────
// ① 任务 id 的形状：能进路径的才收
// ─────────────────────────────────────────────────────────────
ok(sanitizeTaskId("t-abc_123") === "t-abc_123", "正常的任务 id 被改了");
ok(sanitizeTaskId("../../etc/passwd") === "default", "带路径分隔符的 id 没被挡掉");
ok(sanitizeTaskId("a/b") === "default", "带斜杠的 id 没被挡掉");
ok(sanitizeTaskId("") === "default", "空 id 没落回 default");
ok(sanitizeTaskId("x".repeat(200)).length <= 64, "过长的 id 没被截断");
ok(sanitizeTaskId("a".repeat(64)) === "a".repeat(64), "64 位的 id 被误伤了");

// ─────────────────────────────────────────────────────────────
// ② 任务 id 从请求里取得到（头优先，其次 body）
// ─────────────────────────────────────────────────────────────
ok(
  taskIdOf({ headers: { "x-task-id": "t-hdr" }, body: { taskId: "t-body" } }) === "t-hdr",
  "请求头里的任务 id 没被取到",
);
ok(
  taskIdOf({ headers: {}, body: { taskId: "t-body" } }) === "t-body",
  "body 里的任务 id 没被取到",
);
ok(taskIdOf({ headers: {}, body: {} }) === "default", "什么都没有时没落回 default");

// ─────────────────────────────────────────────────────────────
// ③ 两个任务的报告**互不覆盖**
// ─────────────────────────────────────────────────────────────
const A = "_test_isolation_A";
const B = "_test_isolation_B";
const fileA = taskReportFile(A);
const fileB = taskReportFile(B);
ok(fileA !== fileB, "两个任务的报告落到了同一个文件");
ok(fileA.includes(A) && fileB.includes(B), "任务目录里没有任务 id");

try {
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.mkdirSync(path.dirname(fileB), { recursive: true });
  fs.writeFileSync(fileA, JSON.stringify({ task: "A", chapters: [{ id: 1 }] }), "utf-8");
  fs.writeFileSync(fileB, JSON.stringify({ task: "B", chapters: [{ id: 1 }] }), "utf-8");

  const readA = JSON.parse(fs.readFileSync(resolveReportFile(A), "utf-8"));
  const readB = JSON.parse(fs.readFileSync(resolveReportFile(B), "utf-8"));
  ok(readA.task === "A" && readB.task === "B", "两个任务读到的不是对方那份报告");

  // **再写一次 A** —— B 必须不受影响
  fs.writeFileSync(fileA, JSON.stringify({ task: "A2", chapters: [] }), "utf-8");
  const readB2 = JSON.parse(fs.readFileSync(resolveReportFile(B), "utf-8"));
  ok(readB2.task === "B", "写 A 把 B 的报告顶掉了");
} finally {
  for (const p of [fileA, fileB]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 清不掉就算了 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了 */
  }
}

// ─────────────────────────────────────────────────────────────
// ④ 取证结果带**证据范围**
// ─────────────────────────────────────────────────────────────
const scopeCtx = {
  taskId: "t-scope",
  casePack: {
    applies: true,
    casePackId: "gb4785-three-versions",
    family: "GB 4785",
    reason: "",
    sourceFiles: ["源文件_A_GB4785草案V4.3.5_103页.pdf", "源文件_B_GB4785-2019_81页.pdf"],
  },
};
const scopeRes = await runAgentTool("find_quote", { quote: "5.2.4.2 高度" }, scopeCtx);
ok(scopeRes && scopeRes.data, "取证没返回结果");
ok(
  scopeRes.data.evidenceScope?.taskId === "t-scope",
  "取证结果里没有任务 id —— 证据回不到当前任务",
);
ok(
  Array.isArray(scopeRes.data.evidenceScope?.sourceFiles) &&
    scopeRes.data.evidenceScope.sourceFiles.length > 0,
  "取证结果里没有源文件名 —— 读者不知道该翻哪个文件",
);
ok(
  scopeRes.data.evidenceScope?.standardFamily === "GB 4785",
  "取证结果里没有案例包的标准名",
);

// ─────────────────────────────────────────────────────────────
// ⑤ 案例包**不适用** → **不回答**（不是拿别的标准的数据糊弄）
// ─────────────────────────────────────────────────────────────
const badCtx = {
  taskId: "t-other",
  casePack: {
    applies: false,
    casePackId: "gb4785-three-versions",
    family: "GB 4785",
    reason: "这套标准尚未配置：上传的文件不是 GB 4785 那三版之一",
    sourceFiles: [],
  },
};
const badRes = await runAgentTool("find_quote", { quote: "5.2.4.2 高度" }, badCtx);
ok(badRes.ok === false, "案例包不适用时取证居然回答了");
ok(
  String(badRes.data?.error ?? "").includes("尚未配置"),
  "案例包不适用时没有说清「尚未配置」",
);
ok(badRes.data?.evidenceScope?.scope === "not-configured", "结果里没有标出「不适用」");

// ─────────────────────────────────────────────────────────────
// ⑥ 上传清单：按 sha 去重，读得回来
// ─────────────────────────────────────────────────────────────
try {
  appendTaskUpload("_test_isolation_U", { sha256: "a".repeat(64), fileName: "x.pdf", at: "t" });
  appendTaskUpload("_test_isolation_U", { sha256: "a".repeat(64), fileName: "x.pdf", at: "t2" });
  appendTaskUpload("_test_isolation_U", { sha256: "b".repeat(64), fileName: "y.pdf", at: "t" });
  const ups = readTaskUploads("_test_isolation_U");
  ok(ups.length === 2, `上传清单去重不对：${ups.length} 条`);
} finally {
  try {
    fs.rmSync(path.join("reports", "tasks", "_test_isolation_U"), { recursive: true, force: true });
  } catch {
    /* 清不掉就算了 */
  }
}

console.log(`✓ 任务隔离用例全过（${n} 条断言）`);
