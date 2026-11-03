/**
 * 「这个端口上是不是**我自己**的另一个实例？」—— 探针。
 *
 * ## 为什么要有它
 *
 * 端口被占时**静默换到下一个端口**（原来的 `findAvailablePort`）有一个很坏的副作用：
 * 每起一个实例就多一个活着的进程，一个都不退出 ——
 * 实测一次会话里堆到了 **39 个** `tsx server/_core/index.ts` 进程。
 *
 * 真正的伤害不在进程数，在这一条：
 * **你在浏览器里连的 3000 端口，是最早那个旧实例。**
 * 它跑的是旧代码（改源码它不知道），还会把报告写回**同一份**
 * `reports/last-report.json` —— 于是「我刚跑出来的报告怎么标题还是旧的」
 * 这种问题，在服务器日志里查不出任何线索（日志在新起的那个实例上）。
 *
 * 所以：**端口被本项目的另一个实例占着时，响亮地拒绝启动**。
 *
 * ## 怎么认「是我自己」
 *
 * 本项目的每个响应都带 `x-regulatory-copilot: <pid>` 头（见 index.ts）。
 * 探针打 `/api/health`，读这个头 —— 有就是自己人，没有就是别的程序。
 */
import { request as httpRequest } from "node:http";

/** 响应头名 —— 必须与 index.ts 里设置的那个一致。 */
export const INSTANCE_HEADER = "x-regulatory-copilot";

/**
 * 探测某个端口上的服务是不是本项目的实例。
 * @returns 是本项目实例时返回它的 PID，否则 null（端口没人 / 是别的程序 / 超时）。
 */
export function probeOwnInstance(port: number, timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/health", method: "GET", timeout: timeoutMs },
      (res) => {
        const raw = res.headers[INSTANCE_HEADER];
        res.resume();
        const pid = Number(raw);
        resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
