/**
 * instanceProbe 的**已知答案**用例。
 *
 * 探针的判据很简单：请求 /api/health，读 `x-regulatory-copilot` 头。
 * 有头且是数字 → 是本项目的另一个实例，返回它的 PID；没有 → 不是。
 *
 * 用合成服务器驱动（而不是拿真的 dev server 试）：
 * ① 带标记的假服务器 → 必须认出它的 PID；
 * ② 不带标记的假服务器 → 必须认不出（不能把别的程序当成本项目）；
 * ③ 没人监听的端口 → 必须返回 null（不能挂住）。
 */
import http from "node:http";
import { probeOwnInstance, INSTANCE_HEADER } from "./dist/instanceProbe.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

/** 起一个假服务器；withHeader 为 false 时不带实例标记。 */
function startFake(withHeader, pid) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (withHeader) res.setHeader(INSTANCE_HEADER, String(pid));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const portOf = (s) => s.address().port;

// ① 带标记 → 认出 PID
{
  const server = await startFake(true, 424242);
  const pid = await probeOwnInstance(portOf(server));
  server.close();
  ok(pid === 424242, `带标记的实例被认出来（探针返回 ${pid}，应为 424242）`);
}

// ② 不带标记 → 认不出
{
  const server = await startFake(false, 0);
  const pid = await probeOwnInstance(portOf(server));
  server.close();
  ok(pid === null, `不带标记的端口被当成「不是本项目」（探针返回 ${pid}，应为 null）`);
}

// ③ 没人监听 → null，且不挂住
{
  const server = await startFake(true, 1);
  const deadPort = portOf(server);
  server.close();
  await new Promise((r) => server.on("close", r));
  const t0 = Date.now();
  const pid = await probeOwnInstance(deadPort, 800);
  const ms = Date.now() - t0;
  ok(pid === null, `没人监听的端口返回 null（返回 ${pid}）`);
  ok(ms < 3000, `没人监听时不挂住（${ms}ms）`);
}

// ④ 标记不是数字 → 认不出（不能把垃圾当成 PID）
{
  const server = await new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.setHeader(INSTANCE_HEADER, "not-a-pid");
      res.end("{}");
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const pid = await probeOwnInstance(portOf(server));
  server.close();
  ok(pid === null, `非法标记不被当成 PID（返回 ${pid}，应为 null）`);
}

console.log(failures === 0 ? "\n✓ instanceProbe: 4/4 通过" : `\n✗ instanceProbe: ${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
