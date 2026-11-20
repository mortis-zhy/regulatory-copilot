/**
 * **站点级 HTTP Basic Auth** ✓ —— 公网暴露前必须有的一道门 ✓。
 *
 * ## 为什么要有
 *
 * 公司那台机器上另一个服务（出图智能体）已经踩过这个坑 ✓：
 * 「零认证 + 所有人共享任务库」⇒ 公网一开就等于**谁都能看所有人的图纸** ✗。
 * 本项目要放到 `*.innovation-science.cloud` 下面 ✓ ⇒ 同样必须先有认证 ✓。
 *
 * ## 配置（**不配就不拦** ✓ —— 本地开发照旧 ✓）
 *
 * ```env
 * # 格式：<用户名>:<sha256("用户名:口令") 的十六进制>
 * # 不配 ⇒ **完全不拦** ✓（本地开发 ✓）；配了 ⇒ 除白名单外一律 401 ✓。
 * SITE_BASIC_AUTH=gea:6f3b…
 * # 白名单（默认只有健康检查 ✓ —— 容器 HEALTHCHECK 打的就是它 ✓）
 * SITE_BASIC_AUTH_OPEN=/api/health
 * ```
 *
 * **为什么存哈希而不是明文口令** ✓ —— `.env` 里明文口令等于「把口令写进磁盘」✗；
 * 哈希不可逆 ✓，而服务端只需要**比对** ✓（不需要还原口令 ✓）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientIpOf } from "./rateLimit";

/** 默认白名单：健康检查 ✓（容器编排靠它判死活 ✓）。 */
const DEFAULT_OPEN = ["/api/health"];

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export type BasicAuthSpec = {
  /** 用户名（只用于提示 ✓，比对靠哈希 ✓） */
  user: string;
  /** `sha256("<user>:<password>")` ✓ */
  hash: string;
  open: string[];
  /** 连续错几次就锁 ✓（默认 5 ✓） */
  maxFails: number;
  /** 锁多少秒 ✓（默认 60 ✓） */
  lockSec: number;
};

/** 读配置 ✓ —— 没配就返回 null ✓（= 不拦 ✓）。 */
export function basicAuthSpecFromEnv(
  env: Record<string, string | undefined> = process.env,
): BasicAuthSpec | null {
  const raw = (env.SITE_BASIC_AUTH ?? "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  const user = raw.slice(0, idx).trim();
  const hash = raw.slice(idx + 1).trim().toLowerCase();
  if (!user || hash.length !== 64) return null;
  const open = (env.SITE_BASIC_AUTH_OPEN ?? DEFAULT_OPEN.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxFails = Number(env.SITE_BASIC_AUTH_MAX_FAILS ?? 5);
  const lockSec = Number(env.SITE_BASIC_AUTH_LOCK_SEC ?? 60);
  return {
    user,
    hash,
    open: open.length ? open : DEFAULT_OPEN,
    maxFails: Number.isFinite(maxFails) && maxFails > 0 ? maxFails : 5,
    lockSec: Number.isFinite(lockSec) && lockSec > 0 ? lockSec : 60,
  };
}

/* ------------------------------------------------------------------------- */
/* 撞口令的**锁定** ✓                                                         */
/* ------------------------------------------------------------------------- */

/**
 * 失败计数（按 IP ✓）。
 *
 * ## 为什么要有
 *
 * 只有 Basic Auth ⇒ 口令可以被**脚本撞** ✓（公网上有自动字典 ✓）。
 * ⇒ 连续错 **5 次** ⇒ 锁 **60 秒** ✓（和公司那台机器上的另一个服务同一套规矩 ✓）。
 *
 * ## 那个服务上踩过的坑（别照抄 ✗）
 *
 * 它的 `login_locked()` 把「还没锁、只是记了次数」（`until=0` ✓）当成
 * 「锁已过期」直接 `pop` ✓ ⇒ **每次查询都清空计数** ✓ ⇒ 连错 100 次也锁不住 ✗。
 * ⇒ **只有 `until > now` 才算「正在锁」** ✓，计数才留得住 ✓。
 */
type FailState = { count: number; until: number };

const FAILS = new Map<string, FailState>();

/** 清空失败计数 ✓（测试用 ✓ / 管理员解锁用 ✓）。 */
export function resetAuthFailures(): void {
  FAILS.clear();
}

/** 某个 IP 现在是不是锁着 ✓ —— 返回剩余秒数 ✓（0 = 没锁 ✓）。 */
export function authLockedFor(
  key: string,
  now: number = Date.now(),
): number {
  const st = FAILS.get(key);
  if (!st) return 0;
  if (st.until > now) return Math.ceil((st.until - now) / 1000);
  // **过期了就清掉计数** ✓ —— 但**不清也没关系** ✓（下次失败会重新累计 ✓）。
  return 0;
}

/** 记一次失败 ✓ —— 够数就锁 ✓；返回是否锁上了 ✓。 */
export function recordAuthFailure(
  key: string,
  maxFails: number,
  lockSec: number,
  now: number = Date.now(),
): { locked: boolean; retryAfter: number } {
  const st = FAILS.get(key) ?? { count: 0, until: 0 };
  // **只在没锁的时候累计** ✓（锁着的时候不该再累加 ✓）
  if (st.until > now) return { locked: true, retryAfter: Math.ceil((st.until - now) / 1000) };
  st.count += 1;
  if (st.count >= maxFails) {
    st.until = now + lockSec * 1000;
    st.count = 0;
    FAILS.set(key, st);
    return { locked: true, retryAfter: lockSec };
  }
  FAILS.set(key, st);
  return { locked: false, retryAfter: 0 };
}

/** 成功 ⇒ 清掉计数 ✓（一次登录成功就重新开始数 ✓）。 */
export function clearAuthFailures(key: string): void {
  FAILS.delete(key);
}

/**
 * 生成中间件 ✓。
 *
 * - **没配** ⇒ 直接放行 ✓（本地开发 ✓）；
 * - **配了** ⇒ 校验 `Authorization: Basic <base64(user:pass)>` ✓，
 *   比对 `sha256(user:pass)` ✓（**不明文比口令** ✓）；
 * - 白名单路径放行 ✓（默认 `/api/health` ✓）；
 * - 不通过 ⇒ **401 + `WWW-Authenticate`** ✓（浏览器会弹登录框 ✓）。
 */
export function siteBasicAuth(
  spec: BasicAuthSpec | null = basicAuthSpecFromEnv(),
  opts: { keyOf?: (req: Request) => string; now?: () => number } = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const keyOf = opts.keyOf ?? clientIpOf;
  const now = opts.now ?? (() => Date.now());
  return (req, res, next) => {
    if (!spec) return next();
    const path = (req.path || req.url || "").split("?")[0];
    if (spec.open.some((p) => path === p || path.startsWith(p + "/"))) return next();
    const key = keyOf(req);
    // **锁着就先拒** ✓ —— 撞口令的人连「密码对不对」都试不了 ✓。
    const left = authLockedFor(key, now());
    if (left > 0) {
      res.setHeader("Retry-After", String(left));
      return res.status(429).json({
        error: `登录失败次数过多，已锁定 ${left} 秒`,
        code: "auth_locked",
        retryAfter: left,
      });
    }
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      try {
        const raw = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
        if (safeEqual(sha256Hex(raw), spec.hash)) {
          clearAuthFailures(key);
          return next();
        }
      } catch {
        /* 解不开 ⇒ 当没给凭证 ✗ */
      }
    }
    const rec = recordAuthFailure(key, spec.maxFails, spec.lockSec, now());
    if (rec.locked) {
      res.setHeader("Retry-After", String(rec.retryAfter));
      return res.status(429).json({
        error: `登录失败次数过多，已锁定 ${rec.retryAfter} 秒`,
        code: "auth_locked",
        retryAfter: rec.retryAfter,
      });
    }
    res.setHeader("WWW-Authenticate", `Basic realm="Regulatory Copilot", charset="UTF-8"`);
    return res.status(401).send("需要登录（HTTP Basic）");
  };
}
