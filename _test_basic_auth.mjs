/**
 * 站点级 **HTTP Basic Auth** 的已知答案用例 ✓ —— 不调模型 ✓、不起服务 ✓。
 *
 * 钉住三件事：
 * 1. **没配就不拦** ✓（本地开发照旧 ✓）；
 * 2. **配了就得带凭证** ✓ —— 无凭证 / 错口令 ⇒ 401 + `WWW-Authenticate` ✓；
 * 3. **健康检查在白名单里** ✓（容器 HEALTHCHECK 靠它 ✓ ⇒ 否则编排器以为服务死了 ✗）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basicAuthSpecFromEnv, siteBasicAuth } from "./dist/basicAuth.js";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

console.log("\n[test-basic-auth] 站点级 Basic Auth");

const hashOf = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const USER = "gea";
const PASS = "correct horse battery staple";
const SPEC = `${USER}:${hashOf(`${USER}:${PASS}`)}`;

/** 造一个假 req/res ✓（不起服务 ✓）。 */
function fakeRes() {
  const state = { status: 0, headers: {}, body: null, nexted: false };
  return {
    state,
    setHeader(k, v) {
      state.headers[k] = v;
    },
    status(code) {
      state.status = code;
      return this;
    },
    send(b) {
      state.body = b;
      return this;
    },
  };
}
function run(mw, { path = "/", auth } = {}) {
  const req = { path, url: path, headers: auth ? { authorization: auth } : {} };
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => {
    nexted = true;
  });
  return { ...res.state, nexted };
}

// ① 没配 ⇒ 完全不拦 ✓
{
  const spec = basicAuthSpecFromEnv({});
  ok(spec === null, "没配 SITE_BASIC_AUTH 时不该产生配置");
  const mw = siteBasicAuth(spec);
  const r = run(mw, { path: "/" });
  ok(r.nexted === true && r.status === 0, "没配认证时不该拦");
}

// ② 配了 ⇒ 无凭证 401 ✓
{
  const spec = basicAuthSpecFromEnv({ SITE_BASIC_AUTH: SPEC });
  ok(spec && spec.user === USER, "配置没解析出来");
  const mw = siteBasicAuth(spec);
  const r = run(mw, { path: "/" });
  ok(r.status === 401, `没凭证却放行了（status=${r.status}）`);
  ok(String(r.headers["WWW-Authenticate"] ?? "").startsWith("Basic"), "没给 WWW-Authenticate ⇒ 浏览器不会弹登录框");
  ok(r.nexted === false, "没凭证却调了 next");
}

// ③ 口令错 ⇒ 401 ✓；对 ⇒ 放行 ✓
{
  const mw = siteBasicAuth(basicAuthSpecFromEnv({ SITE_BASIC_AUTH: SPEC }));
  const wrong = run(mw, { auth: `Basic ${Buffer.from(`${USER}:wrong`).toString("base64")}` });
  ok(wrong.status === 401, "错口令却放行了");
  const right = run(mw, { auth: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` });
  ok(right.nexted === true && right.status === 0, "对的口令没放行");
  const malformed = run(mw, { auth: "Basic !!!not-base64!!!" });
  ok(malformed.status === 401, "乱码凭证没被挡");
}

// ④ 健康检查在白名单里 ✓（默认 ✓）
{
  const mw = siteBasicAuth(basicAuthSpecFromEnv({ SITE_BASIC_AUTH: SPEC }));
  const r = run(mw, { path: "/api/health" });
  ok(r.nexted === true && r.status === 0, "健康检查被拦了 ⇒ 容器 HEALTHCHECK 会以为服务死了");
}

// ⑤ 配置坏了（没有冒号 / 哈希长度不对）⇒ **当没配** ✓（不因为配置写错就把服务锁死 ✗）
{
  ok(basicAuthSpecFromEnv({ SITE_BASIC_AUTH: "no-colon" }) === null, "没有冒号的配置不该被采纳");
  ok(basicAuthSpecFromEnv({ SITE_BASIC_AUTH: "gea:short" }) === null, "哈希长度不对不该被采纳");
}

console.log(`\n✓ Basic Auth 用例全过（${n} 条断言）`);
