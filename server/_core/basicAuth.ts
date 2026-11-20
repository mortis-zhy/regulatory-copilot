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
  return { user, hash, open: open.length ? open : DEFAULT_OPEN };
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
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!spec) return next();
    const path = (req.path || req.url || "").split("?")[0];
    if (spec.open.some((p) => path === p || path.startsWith(p + "/"))) return next();
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      try {
        const raw = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
        if (safeEqual(sha256Hex(raw), spec.hash)) return next();
      } catch {
        /* 解不开 ⇒ 当没给凭证 ✗ */
      }
    }
    res.setHeader("WWW-Authenticate", `Basic realm="Regulatory Copilot", charset="UTF-8"`);
    return res.status(401).send("需要登录（HTTP Basic）");
  };
}
