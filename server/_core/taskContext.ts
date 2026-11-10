/**
 * **任务上下文** —— 一次对比任务的身份（同事 issue #2）。
 *
 * ## 要挡的是什么
 *
 * 同事的原话：「取证工具使用全局索引、台账和源 PDF，并在进程中缓存；
 * 报告也保存在共享位置。换文件或多人同时使用时，可能查到旧资料或覆盖其他任务。」
 *
 * 拆成两件事：
 *
 * | 共享的东西 | 现在怎么处理 |
 * |---|---|
 * | **上传的源文件** | 早就按**内容哈希**存（`uploaded-docs/<sha 前16位>.pdf`）✓ —— 不同文件不会互相顶掉 |
 * | **报告 JSON** | 原来写**同一个** `reports/last-report.json` ✗ → 现在**按任务分目录** |
 * | **取证用的索引/台账** | 那是**案例包**的资料（某一套标准）—— 关键是**先判这份输入是不是这一套**，不适用就**不回答**（而不是拿别的标准的数据糊弄过去） |
 *
 * ## 任务 id 从哪来
 *
 * 客户端在**上传清单变化**时生成一个新的 id，
 * 每个请求都带 `X-Task-Id` 头 ✓ ——
 * 用头而不是 body，是为了不改任何请求体的形状。
 *
 * 没有头（老客户端 / curl / CLI）→ 落回 `default`，
 * 也就是**原来的共享路径** ✓ —— 旧用法不受影响。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./projectRoot";

/** 没有任务 id 时用的那个（「共享的那一份」）。 */
export const DEFAULT_TASK_ID = "default";

/**
 * 任务 id 的形状 —— **只允许**字母、数字、下划线、连字符。
 *
 * 为什么这么严：它要被拼进**文件路径** ✓。
 * 一个能带 `../` 的 id 就是**任意写文件** ✗。
 */
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 把任意输入收拾成一个能安全进路径的任务 id。 */
export function sanitizeTaskId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return SAFE_TASK_ID.test(s) ? s : DEFAULT_TASK_ID;
}

/** 从请求里取任务 id：头优先，其次 body / query。 */
export function taskIdOf(req: {
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string {
  const h = req?.headers ?? {};
  const raw =
    (h["x-task-id"] as unknown) ??
    (h["X-Task-Id"] as unknown) ??
    req?.body?.taskId ??
    req?.query?.taskId;
  return sanitizeTaskId(raw);
}

/** 这个任务的**产物目录**。 */
export function taskDir(taskId: string): string {
  const id = sanitizeTaskId(taskId);
  return id === DEFAULT_TASK_ID
    ? path.join(PROJECT_ROOT, "reports")
    : path.join(PROJECT_ROOT, "reports", "tasks", id);
}

/** 这个任务的报告文件。 */
export function taskReportFile(taskId: string): string {
  return path.join(taskDir(taskId), "last-report.json");
}

/** 这个任务的草稿文件（快速草稿那条管线）。 */
export function taskDraftFile(taskId: string): string {
  return path.join(taskDir(taskId), "last-report.llm-sse.json");
}

/**
 * 读这个任务的报告。
 *
 * ## 为什么不落回共享的那一份
 *
 * 落回 = **拿别的任务的报告当自己的** ✗ ——
 * 那正是同事 issue #2 说的「查到旧资料」。
 * 所以：**带任务 id 的请求只看自己那一份** ✓；
 * 没带 id 的（`default`）才用共享路径 ✓（老的用法不受影响 ✓）。
 */
export function resolveReportFile(
  taskId: string,
  kind: "report" | "draft" = "report",
): string {
  const id = sanitizeTaskId(taskId);
  if (id === DEFAULT_TASK_ID) {
    return kind === "draft"
      ? path.join(PROJECT_ROOT, "reports", "last-report.llm-sse.json")
      : path.join(PROJECT_ROOT, "reports", "last-report.json");
  }
  return kind === "draft" ? taskDraftFile(id) : taskReportFile(id);
}

/** 这个任务上传过哪些文件（sha256 + 文件名）—— 用来判案例包适不适用。 */
export type TaskUpload = { sha256: string; fileName: string; at: string };

export function taskUploadsFile(taskId: string): string {
  return path.join(taskDir(taskId), "uploads.json");
}

/** 读这个任务的上传清单（没有就是空）。 */
export function readTaskUploads(taskId: string): TaskUpload[] {
  try {
    const p = taskUploadsFile(taskId);
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 往这个任务的上传清单里追加一条（按 sha 去重）。 */
export function appendTaskUpload(taskId: string, up: TaskUpload): void {
  try {
    const p = taskUploadsFile(taskId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cur = readTaskUploads(taskId).filter((x) => x.sha256 !== up.sha256);
    cur.push(up);
    fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n", "utf8");
  } catch {
    /* 清单写不进去不该让上传失败 —— 上传本身已经成功了 ✓ */
  }
}
