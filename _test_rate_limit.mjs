/**
 * **限流 + 撞口令锁定**的已知答案用例 ✓ —— 不调模型 ✓、不起服务 ✓。
 *
 * 钉住：
 * 1. 普通接口 240 次/分、重接口 30 次/小时 ✓（默认 ✓）；
 * 2. **静态资源与健康检查不限流** ✓（不然正常访问会被自己锁在门外 ✗）；
 * 3. 超了 ⇒ **429 + Retry-After** ✓；
 * 4. **连续错 5 次 ⇒ 锁 60 秒** ✓；锁着时连「对不对」都不试 ✓；
 * 5. **锁不能被「查询」清掉** ✓ —— 公司那台机器上的另一个服务就栽在这 ✗
 *    （把「还没锁」当成「锁过期」⇒ 每次查询都清空计数 ⇒ 连错 100 次也锁不住 ✗）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeRateLimiter, limitsFromEnv, clientIpOf, makeConcurrencyGuard, heavyConcurrencyFromEnv } from "./dist/rateLimit.js";
import { siteBasicAuth, basicAuthSpecFromEnv, resetAuthFailures } from "./dist/basicAuth.js";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

console.log("\n[test-rate-limit] 限流与撞口令锁定");

function fakeRes() {
  const state = { status: 0, headers: {}, body: null };
  return {
    state,
    setHeader(k, v) {
      state.headers[k] = v;
    },
    status(c) {
      state.status = c;
      return this;
    },
    json(b) {
      state.body = b;
      return this;
    },
    send(b) {
      state.body = b;
      return this;
    },
  };
}
function call(mw, { path = "/api/x", ip = "1.2.3.4", auth } = {}) {
  const req = { path, url: path, headers: auth ? { authorization: auth } : {}, socket: { remoteAddress: ip } };
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => {
    nexted = true;
  });
  return { ...res.state, nexted };
}

// ── ① 默认规则 ───────────────────────────────────────────────────────────
{
  const l = limitsFromEnv({});
  ok(l.normal.max === 240 && l.normal.windowMs === 60_000, "普通接口默认应是 240 次/分");
  ok(l.heavy.max === 30 && l.heavy.windowMs === 3_600_000, "重接口默认应是 30 次/小时");
  const l2 = limitsFromEnv({ RATE_LIMIT_PER_MIN: "10", RATE_LIMIT_HEAVY_PER_HOUR: "2" });
  ok(l2.normal.max === 10 && l2.heavy.max === 2, "环境变量没生效");
  const l3 = limitsFromEnv({ RATE_LIMIT_PER_MIN: "0" });
  ok(l3.normal.max === 240, "配了 0 应该退回默认（0 次/分 = 全禁 ✗）");
}

// ── ② 普通接口超限 ───────────────────────────────────────────────────────
{
  const mw = makeRateLimiter({
    heavy: { windowMs: 3_600_000, max: 30, name: "重接口" },
    normal: { windowMs: 60_000, max: 5, name: "普通接口" },
    keyOf: (req) => req.socket.remoteAddress,
  });
  for (let i = 0; i < 5; i++) {
    const r = call(mw, { path: "/api/agent/chat/agent" });
    ok(r.nexted === true, `第 ${i + 1} 次不该被限`);
  }
  const over = call(mw, { path: "/api/agent/chat/agent" });
  ok(over.status === 429, `超限没被拦（status=${over.status}）`);
  ok(Number(over.headers["Retry-After"]) > 0, "429 缺 Retry-After");
  ok(over.body?.code === "rate_limited", "429 的 body 缺 code");
  // **别的 IP 不受影响** ✓
  const other = call(mw, { path: "/api/agent/chat/agent", ip: "9.9.9.9" });
  ok(other.nexted === true, "限流误伤了别的 IP");
}

// ── ③ 重接口走重规则（30/小时那个档）───────────────────────────────────
{
  const mw = makeRateLimiter({
    heavy: { windowMs: 3_600_000, max: 2, name: "重接口" },
    normal: { windowMs: 60_000, max: 100, name: "普通接口" },
    keyOf: (req) => req.socket.remoteAddress,
  });
  call(mw, { path: "/api/agent/report/generate" });
  call(mw, { path: "/api/agent/report/render" });
  const over = call(mw, { path: "/api/agent/report/pdf" });
  ok(over.status === 429, "重接口没走重规则（30 次/小时那一档 ✗）");
}

// ── ④ 静态资源与健康检查**不限流** ✓ ───────────────────────────────────
{
  const mw = makeRateLimiter({
    heavy: { windowMs: 3_600_000, max: 1, name: "重接口" },
    normal: { windowMs: 60_000, max: 1, name: "普通接口" },
    keyOf: (req) => req.socket.remoteAddress,
  });
  for (let i = 0; i < 20; i++) {
    const s = call(mw, { path: "/assets/index-abc123.js" });
    ok(s.nexted === true, "静态资源被限流了（正常访问会 429 ✗）");
  }
  const h = call(mw, { path: "/api/health" });
  ok(h.nexted === true, "健康检查被限流了（编排器会以为服务死了 ✗）");
}

// ── ⑤ 客户端 IP：优先 CF 的头 ✓ ──────────────────────────────────────
{
  const req = { headers: { "cf-connecting-ip": "8.8.8.8" }, socket: { remoteAddress: "10.0.0.1" } };
  ok(clientIpOf(req) === "8.8.8.8", "没取 CF-Connecting-IP");
  const req2 = { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: { remoteAddress: "10.0.0.1" } };
  ok(clientIpOf(req2) === "9.9.9.9", "没取 X-Forwarded-For 的第一段");
  const req3 = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  ok(clientIpOf(req3) === "10.0.0.1", "没退回 socket 地址");
}

// ── ⑥ 撞口令：错 5 次 ⇒ 锁 60 秒 ✓ ──────────────────────────────────
{
  resetAuthFailures();
  const hash = createHash("sha256").update("gea:pw").digest("hex");
  const spec = basicAuthSpecFromEnv({ SITE_BASIC_AUTH: `gea:${hash}` });
  ok(!!spec && spec.maxFails === 5 && spec.lockSec === 60, "默认 5 次 / 60 秒不对");
  let t = 1_000_000;
  const mw = siteBasicAuth(spec, { keyOf: () => "ip-1", now: () => t });
  const wrong = `Basic ${Buffer.from("gea:bad").toString("base64")}`;
  for (let i = 0; i < 4; i++) {
    const r = call(mw, { path: "/", auth: wrong });
    ok(r.status === 401, `第 ${i + 1} 次错口令应是 401（实际 ${r.status}）`);
  }
  const fifth = call(mw, { path: "/", auth: wrong });
  ok(fifth.status === 429, `第 5 次错口令应被锁（实际 ${fifth.status}）`);
  // **锁着的时候，正确口令也不给进** ✓
  const right = `Basic ${Buffer.from("gea:pw").toString("base64")}`;
  const locked = call(mw, { path: "/", auth: right });
  ok(locked.status === 429, "锁着的时候正确口令也放行了（等于没锁 ✗）");
  // **锁不会因为「查一下」而被清掉** ✓（另一个服务就栽在这 ✗）
  t += 61_000;
  const after = call(mw, { path: "/", auth: wrong });
  ok(after.status === 401, "锁过期后应回到 401 而不是继续 429");
  // 成功一次 ⇒ 计数清零 ✓
  const okres = call(mw, { path: "/", auth: right });
  ok(okres.nexted === true, "锁过期后正确口令应放行");
  resetAuthFailures();
}

// ── ⑦ 重活并发闸：同时只放行 N 个，其余 503 ───────────────────────────
{
  const guard = makeConcurrencyGuard({ max: 1, prefixes: ["/api/agent/report/render"] });
  const mk = () => {
    const state = { status: 0, body: null };
    const res = {
      state,
      on() {},
      setHeader() {},
      status(c) {
        state.status = c;
        return this;
      },
      json(b) {
        state.body = b;
        return this;
      },
    };
    return res;
  };
  // 第一个请求「在飞」⇒ 第二个应被拒 ✓
  let nexted = false;
  const res1 = mk();
  guard({ path: "/api/agent/report/render", url: "" }, res1, () => {
    nexted = true;
  });
  ok(nexted === true, "第一个重请求没放行");
  const res2 = mk();
  let nexted2 = false;
  guard({ path: "/api/agent/report/render", url: "" }, res2, () => {
    nexted2 = true;
  });
  ok(nexted2 === false && res2.state.status === 503, "第二个重请求没被并发闸拦住");
  // **普通接口不受影响** ✓
  let nexted3 = false;
  const res3 = mk();
  guard({ path: "/api/agent/chat/agent", url: "" }, res3, () => {
    nexted3 = true;
  });
  ok(nexted3 === true, "并发闸误伤了普通接口");
  ok(heavyConcurrencyFromEnv({}) === 1, "重活并发默认应是 1");
  ok(heavyConcurrencyFromEnv({ HEAVY_CONCURRENCY: "2" }) === 2, "并发上限没读环境变量");
}

console.log(`\n✓ 限流与锁定用例全过（${n} 条断言）`);
