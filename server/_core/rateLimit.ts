/**
 * **按 IP 的限流** ✓ —— 公网暴露后的第一道应用侧防线 ✓。
 *
 * ## 为什么要有
 *
 * Cloudflare 边缘吸收的是 **L3/L4 的洪水** ✓（UDP/SYN/放大 ✓）——
 * 但**应用层**的洪泛（脚本反复打接口、上传、跑渲染 ✓）边缘**不一定管** ✗
 * （没配 WAF 规则 / 速率限制时 ✗）。而本项目**单进程** ✓ + **Chromium 渲染吃内存** ✓
 * ⇒ 几个并发的渲染请求就能把服务**拖垮** ✓。
 *
 * ## 两条规则（默认 ✓，都能用环境变量改 ✓）
 *
 * | 规则 | 默认 | 覆盖 |
 * |---|---|---|
 * | 普通接口 | **240 次 / 分** ✓ | 全部 `/api/*` ✓ |
 * | 重接口 | **30 次 / 小时** ✓ | 报告生成 / 渲染 / 导出 ✓（吃 CPU 与内存 ✓） |
 *
 * ## 客户端 IP 怎么取 ✓
 *
 * 源站**只在隧道后面**可达 ✓（公网 IP 不暴露 ✓）⇒ 所以**可以信** `CF-Connecting-IP` ✓
 * （Cloudflare 边缘加的头 ✓）/ `X-Forwarded-For` 的第一段 ✓；
 * 取不到就退回 socket 的对端地址 ✓。
 *
 * ⚠ **如果哪天把源站直接暴露到公网** ✗ ⇒ 这两个头就能被伪造 ✗ ⇒
 * 限流会形同虚设 ✗ ⇒ 那时必须改成只信 socket 地址 ✓。这件事写在部署文档里 ✓。
 */
import type { NextFunction, Request, Response } from "express";

export type RateLimitRule = {
  /** 窗口长度（毫秒）✓ */
  windowMs: number;
  /** 窗口内允许的次数 ✓ */
  max: number;
  /** 规则名（报错时说清是哪条 ✓） */
  name: string;
};

export type RateLimiter = (req: Request, res: Response, next: NextFunction) => void;

/** 从请求里取**客户端 IP** ✓（隧道后面可以信 CF 的头 ✓）。 */
export function clientIpOf(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return String(req.socket?.remoteAddress ?? "unknown");
}

/** 按路径挑规则 ✓ —— 重接口先挑中 ✓，否则用普通规则 ✓。 */
export function ruleForPath(path: string, heavy: RuleLimitRule, normal: RuleLimitRule): RuleLimitRule {
  const p = path.toLowerCase();
  if (
    p.includes("/report/generate") ||
    p.includes("/report/render") ||
    p.includes("/report/pdf") ||
    p.includes("/report/word")
  ) {
    return heavy;
  }
  return normal;
}

/**
 * 滑动窗口限流器 ✓。
 *
 * **不用第三方包** ✓ —— 几十行就够 ✓，而且**行为可测** ✓（用注入的 `now` ✓）。
 */
export function makeRateLimiter(opts: {
  heavy: RuleLimitRule;
  normal: RuleLimitRule;
  /** 取客户端 IP ✓（默认 `clientIpOf` ✓） */
  keyOf?: (req: Request) => string;
  /** 取当前时间（毫秒）✓ —— 测试可注入 ✓ */
  now?: () => number;
  /** 放行的路径前缀 ✓（健康检查 ✓ —— 编排器一直在打它 ✓） */
  skipPrefixes?: string[];
}): RateLimiter {
  const heavy = opts.heavy;
  const normal = opts.normal;
  const keyOf = opts.keyOf ?? clientIpOf;
  const now = opts.now ?? (() => Date.now());
  const skip = opts.skipPrefixes ?? ["/api/health"];
  /** key → 时间戳数组（滑动窗口 ✓） */
  const hits = new Map<string, number[]>();

  return (req, res, next) => {
    const path = (req.path || req.url || "").split("?")[0];
    if (skip.some((s) => path === s || path.startsWith(s + "/"))) return next();
    // **静态资源不限流** ✓ —— 页面要加载一堆 js/css ✓，
    // 限了它们 ⇒ 正常访问也会被 429 ✗（自己把自己锁在门外 ✗）。
    if (/\.[a-z0-9]{2,5}$/i.test(path)) return next();
    const rule = ruleForPath(path, heavy, normal);
    const key = `${rule.name}:${keyOf(req)}`;
    const t = now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < rule.windowMs);
    if (arr.length >= rule.max) {
      const retryAfter = Math.ceil((rule.windowMs - (t - (arr[0] ?? t))) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      res.setHeader("X-RateLimit-Rule", rule.name);
      return res.status(429).json({
        error: `请求太频繁（${rule.name}：${rule.max} 次 / ${Math.round(rule.windowMs / 1000)} 秒）`,
        code: "rate_limited",
        retryAfter: Math.max(1, retryAfter),
      });
    }
    arr.push(t);
    hits.set(key, arr);
    // **顺手清掉过期条目** ✓ —— 不然 key 会越积越多 ✗
    if (hits.size > 4096) {
      for (const [k, v] of hits) {
        const kept = v.filter((x) => t - x < heavy.windowMs);
        if (!kept.length) hits.delete(k);
        else hits.set(k, kept);
      }
    }
    return next();
  };
}

/** 从环境变量读两条规则 ✓（默认 240/分、30/小时 ✓）。 */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): {
  heavy: RuleLimitRule;
  normal: RuleLimitRule;
} {
  const perMin = Number(env.RATE_LIMIT_PER_MIN ?? 240);
  const perHour = Number(env.RATE_LIMIT_HEAVY_PER_HOUR ?? 30);
  return {
    normal: { windowMs: 60_000, max: Number.isFinite(perMin) && perMin > 0 ? perMin : 240, name: "普通接口" },
    heavy: {
      windowMs: 3_600_000,
      max: Number.isFinite(perHour) && perHour > 0 ? perHour : 30,
      name: "重接口",
    },
  };
}

/**
 * **重活并发闸** ✓ —— 限流管的是「多少次」，这个管的是「**同时几个**」✓。
 *
 * ## 为什么两个都要
 *
 * 30 次/小时 ⇒ 理论上可以**同时**发起 30 个渲染请求 ✓ ⇒
 * 单进程 node ✓ + 每个请求起一个 Chromium ✓ ⇒ **内存直接爆** ✗。
 * ⇒ 同一时刻只放行 **1 个**（默认 ✓），其余立刻回 **503**（不排队 ✓ ——
 * 排队的请求会**占着连接不放** ✗，对攻击者反而更划算 ✓）。
 */
export function makeConcurrencyGuard(opts: {
  max: number;
  /** 路径前缀 ✓（只挡这些 ✓） */
  prefixes: string[];
  name?: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  let inflight = 0;
  const max = Math.max(1, opts.max);
  return (req, res, next) => {
    const path = (req.path || req.url || "").split("?")[0];
    if (!opts.prefixes.some((p) => path.startsWith(p))) return next();
    if (inflight >= max) {
      res.setHeader("Retry-After", "30");
      return res.status(503).json({
        error: `服务正忙（同时最多 ${max} 个重任务 ✓）—— 稍后再试`,
        code: "busy",
      });
    }
    inflight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight = Math.max(0, inflight - 1);
    };
    res.on("finish", release);
    res.on("close", release);
    try {
      return next();
    } catch (e) {
      release();
      throw e;
    }
  };
}

/** 重活并发上限 ✓（默认 1 ✓；`HEAVY_CONCURRENCY` 可调 ✓）。 */
export function heavyConcurrencyFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.HEAVY_CONCURRENCY ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
