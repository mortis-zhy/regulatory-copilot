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
 * 一份**模型凭据** —— 不只是 key，还带着「**打哪、用哪个模型**」。
 *
 * ## 为什么不能只有 key
 *
 * 原来池子里只有 key ✗ ⇒ 所有 key 打的是**同一个 base_url / 同一个模型** ✓
 * ⇒ 换供应商就得改代码 ✗。
 *
 * 实测（2026-11-14）：MiniMax 的两把 key **额度全满** ✗（402 ✗），
 * 而手上有一把能用的 OpenAI key ✓ —— 但池子带不了它 ✗
 * （打 MiniMax 报 401 ✗）。
 *
 * ⇒ 池子里的每一项现在都带 **baseUrl + model** ✓ ⇒
 * **MiniMax 额度满 ⇒ 自动切到 OpenAI 那把** ✓，**不用改代码** ✓。
 */
export type ModelCredential = {
  /** 供应商名（`minimax` / `openai` / 自定义） */
  provider: string;
  key: string;
  baseUrl: string;
  model: string;
  /** 该供应商是不是 MiniMax（决定用不用它的原生路由与 `thinking` 参数 ✓） */
  native: boolean;
};

/** 各供应商的默认值（**能用环境变量覆盖** ✓） */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string; native: boolean }> = {
  minimax: {
    baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
    native: true,
  },
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    native: false,
  },
};

/**
 * **跨供应商**的凭据池。
 *
 * 配置（`.env`）：
 *   MINIMAX_API_KEY=主 key
 *   MINIMAX_API_KEY_FALLBACK=兜底 key,再来一把      ← 同一供应商 ✓
 *   MODEL_KEY_POOL=openai:sk-xxx:https://api.openai.com/v1:gpt-6.1-sol   ← 别的供应商 ✓
 *
 * `MODEL_KEY_POOL` 的每一条：`供应商|key|baseUrl|模型` ✓（逗号分隔 ✓）。
 *
 * **分隔符为什么用 `|` 而不是 `:`** ✓ —— baseUrl 自己带 `:`（`https://…` ✗），
 * 用 `:` 切会把地址切成两半 ✗（实测切出 `baseUrl="https"` ✓ —— 那是个废地址 ✗）。
 *
 * 供应商不认识 ⇒ 走 `baseUrl`/`模型` 里显式给的值 ✓，两个都不给 ⇒ 这条被跳过 ✓
 * （**宁可空着，不可错着** ✓ —— 猜一个地址打过去只会浪费时间 ✗）。
 */
export function modelCredentialPool(): ModelCredential[] {
  const out: ModelCredential[] = [];
  const seen = new Set<string>();
  const push = (c: ModelCredential) => {
    // **按 key 去重** ✓ —— 同一把 key 不该在池子里出现两次 ✓
    // （哪怕挂在两个供应商名下 ✓ —— 那也是同一把 secret ✓）。
    if (!c.key || seen.has(c.key)) return;
    seen.add(c.key);
    out.push(c);
  };

  // ① MiniMax 的那一批（保持原有语义 ✓）
  const mm = PROVIDER_DEFAULTS.minimax;
  for (const key of minimaxKeyPool()) {
    push({ provider: "minimax", key, baseUrl: mm.baseUrl, model: mm.model, native: mm.native });
  }

  // ② 别的供应商（可选 ✓）
  for (const raw of (process.env.MODEL_KEY_POOL ?? "").split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split("|");
    const provider = (parts[0] ?? "").trim().toLowerCase();
    const key = (parts[1] ?? "").trim();
    if (!provider || !key) continue;
    const def = PROVIDER_DEFAULTS[provider];
    const baseUrl = (parts[2] ?? "").trim() || def?.baseUrl || "";
    const model = (parts[3] ?? "").trim() || def?.model || "";
    if (!baseUrl || !model) {
      // **没有 baseUrl / 模型就不猜** ✓ —— 猜一个只会白跑一次 ✗
      console.warn(`[model-pool] 跳过一条 MODEL_KEY_POOL（供应商「${provider}」缺 baseUrl 或模型）`);
      continue;
    }
    push({ provider, key, baseUrl: baseUrl.replace(/\/$/, ""), model, native: def?.native ?? false });
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
  opts?: { label?: string; retries?: number; backoffMs?: number },
): Promise<T> {
  // **池子用「跨供应商凭据池」** ✓ ——
  // 这样 `MODEL_KEY_POOL` 里别的供应商也参与轮换 ✓（MiniMax 额度满 ⇒ 自动切过去 ✓），
  // 而且 `attempt(key, index)` 的 **index 与 `modelCredentialPool()` 对得上** ✓
  // （调用方按 index 取回那一项的 baseUrl / 模型 ✓）。
  const pool = modelCredentialPool().map((c) => c.key);
  if (!pool.length) throw new Error("MINIMAX_API_KEY 未配置");
  const label = opts?.label ?? "minimax";
  const retries = Math.max(0, opts?.retries ?? 2);
  const backoff = opts?.backoffMs ?? 1500;
  let lastErr = { status: 0, body: "no key" };
  let lastTransport = "";
  for (let i = 0; i < pool.length; i++) {
    // ---- 传输层失败：原地重试（换 key 没用 ✗ —— 那是网络的问题 ✓）--------
    //
    // `fetch` 抛异常（网络抖 / 连接重置 / 超时 ✗）**不是 HTTP 状态码** ✗ ——
    // 原来的轮换判据抓不到它 ✗ → 异常直接穿透 ✗
    // → **整个样本段废掉** ✗（实测 32/35 个样本 ✗）。
    let res: { ok: true; value: T } | { ok: false; status: number; body: string } | null = null;
    for (let attemptNo = 0; attemptNo <= retries; attemptNo++) {
      try {
        res = await attempt(pool[i], i);
        break;
      } catch (e) {
        lastTransport = e instanceof Error ? e.message : String(e);
        if (attemptNo < retries) {
          await new Promise((r) => setTimeout(r, backoff * (attemptNo + 1)));
          continue;
        }
        res = null;
      }
    }
    if (res === null) {
      // 这把 key 的传输层彻底不通 ✗ → 换下一把 ✗（也许只是它的连接坏了 ✗）
      lastErr = { status: 0, body: lastTransport };
      if (i === pool.length - 1) break;
      console.warn(
        `[${label}] 第 ${i + 1} 把 key 传输失败（${String(lastTransport).slice(0, 100)}），换下一把`,
      );
      continue;
    }
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
  const err = new Error(`MiniMax ${lastErr.status}: ${String(lastErr.body).slice(0, 200)}`) as Error & {
    transport?: boolean;
  };
  // **传输失败 ≠ 模型答错** ✓ —— 调用方要能分开说 ✓
  if (lastErr.status === 0 && lastTransport) {
    err.transport = true;
    err.message = `传输失败（网络/连接，不是模型的问题）：${String(lastTransport).slice(0, 160)}`;
  }
  throw err;
}
