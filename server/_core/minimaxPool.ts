/**
 * MiniMax key 池与轮换。
 *
 * 为什么要有这个：
 *   MiniMax 的账号配额是**按 key 计**的。主 key（.env 的 MINIMAX_API_KEY）
 *   撞到「Token Plan 用量上限」时，整个 agent 问答链路就断了 ——
 *   而报告生成、97 项闸门、参数取值全是确定性管线，不该被一把 key 卡住。
 *
 *   所以：把多把 key 排成池，主 key 报**配额/额度类**错误就自动切下一把。
 *   401/403（key 本身失效）也切；400（请求写错了）**不切** —— 换了 key 也是错。
 *
 * 配置（.env）：
 *   MINIMAX_API_KEY=主 key
 *   MINIMAX_API_KEY_FALLBACK=兜底 key（可用逗号分隔多把，按顺序轮换）
 *
 * 密钥本身**只从环境变量读**，不落任何日志、不进任何交付件。
 */

/** 按配置顺序取出可用的 key 池（去重、保持顺序、跳过空串）。 */
export function minimaxKeyPool(): string[] {
  const raw = [
    process.env.MINIMAX_API_KEY ?? "",
    ...(process.env.MINIMAX_API_KEY_FALLBACK ?? "").split(","),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of raw.map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 这个失败是不是「换一把 key 也许能好」？
 *
 * 值得切的：
 *   402 insufficient_balance —— 余额不足
 *   429 rate_limit_error     —— Token Plan 用量上限 / 限流
 *   401 / 403                —— 这把 key 失效或没这个模型的权限
 *   body 里含 base_resp.status_code 1008（insufficient balance）
 *     —— MiniMax 的 native 路由**HTTP 200 也会把失败写进 body**，
 *        只看 HTTP 状态码会漏掉
 *
 * 不值得切的：400（请求本身写错了）、5xx（服务端抖，换 key 也一样）。
 */
export function isKeyRotationError(status: number, body: string): boolean {
  if (status === 402 || status === 429 || status === 401 || status === 403) return true;
  const b = String(body ?? "").toLowerCase();
  if (b.includes("insufficient_balance")) return true;
  if (b.includes("用量上限")) return true;
  if (b.includes("余额")) return true;
  if (b.includes("rate_limit")) return true;
  // MiniMax native 路由的 200 + base_resp.status_code 1008
  if (/"status_code"\s*:\s*1008/.test(b)) return true;
  if (/"status_msg"\s*:\s*"[^"]*(balance|quota|limit)/.test(b)) return true;
  return false;
}

/**
 * 把「一串 key 依次试」这件事收在一处。
 *
 * `attempt` 收到一把 key，要么返回 { ok: true, value }，要么返回
 * { ok: false, status, body } —— 后者会被判定是否该换下一把。
 *
 * 全部 key 都失败时，抛出**最后一把**的错误（信息最有价值）。
 */
export async function withKeyRotation<T>(
  attempt: (key: string, index: number) => Promise<
    { ok: true; value: T } | { ok: false; status: number; body: string }
  >,
  opts?: { label?: string },
): Promise<T> {
  const pool = minimaxKeyPool();
  if (!pool.length) throw new Error("MINIMAX_API_KEY 未配置");
  const label = opts?.label ?? "minimax";
  let lastErr = { status: 0, body: "no key" };
  for (let i = 0; i < pool.length; i++) {
    const res = await attempt(pool[i], i);
    if (res.ok) {
      if (i > 0) console.warn(`[${label}] 用第 ${i + 1} 把 key 成功（前 ${i} 把额度/权限不可用）`);
      return res.value;
    }
    lastErr = { status: res.status, body: res.body };
    const isLast = i === pool.length - 1;
    if (!isKeyRotationError(res.status, res.body)) break; // 400 之类 —— 换 key 也没用
    if (isLast) break;
    console.warn(
      `[${label}] 第 ${i + 1} 把 key 不可用（HTTP ${res.status}：${String(res.body).slice(0, 120)}），自动切下一把`,
    );
  }
  throw new Error(`MiniMax ${lastErr.status}: ${String(lastErr.body).slice(0, 200)}`);
}
