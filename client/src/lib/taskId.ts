/**
 * **任务 id** —— 一次对比任务的身份（同事 issue #2）。
 *
 * ## 为什么要有
 *
 * 报告原来写**同一个** `reports/last-report.json` ——
 * 两个任务并行时，后一个把前一个的顶掉 ✗，
 * 而用户点「下载 PDF」拿到的是**别人的报告** ✗。
 *
 * ## 形状
 *
 * 服务端只接受 `[A-Za-z0-9_-]{1,64}` ✓ ——
 * 它要被拼进**文件路径**（`reports/tasks/<id>/`），
 * 一个能带 `../` 的 id 就是**任意写文件** ✗。
 */

const KEY = "regulatory-copilot:task-id";

/** 生成一个新的任务 id。 */
export function newTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36);
  return `t${t}${rand}`;
}

/**
 * 这次会话的任务 id —— **刷新页面也不变** ✓。
 *
 * 变了的话，刷新一次就「换了个任务」，
 * 之前生成的报告在新的任务目录里找不到了 ✗。
 */
export function currentTaskId(): string {
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved && /^[A-Za-z0-9_-]{1,64}$/.test(saved)) return saved;
    const id = newTaskId();
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    // 没有 sessionStorage（SSR / 隐私模式）→ 每次一个新的，
    // 但**同一个页面生命周期内**要一致 ✓（靠 React state 记住）。
    return newTaskId();
  }
}

/** **重新开始一个任务**（用户清空重来时调用）。 */
export function resetTaskId(): string {
  const id = newTaskId();
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    /* 存不了就算了 */
  }
  return id;
}

/** 带上任务 id 的请求头。 */
export function taskHeaders(
  taskId: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return { "x-task-id": taskId, ...(extra ?? {}) };
}
