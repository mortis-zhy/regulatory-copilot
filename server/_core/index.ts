import "dotenv/config";
import express from "express";
import { createServer } from "http";
import nodeFs from "node:fs";
import nodePath from "node:path";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerAgentRoutes } from "./agentRoutes";
import { registerParameterProposalRoutes } from "./parameterProposals";
import { PROJECT_ROOT, REPORT_FILE } from "./projectRoot";
import { INSTANCE_HEADER, probeOwnInstance } from "./instanceProbe";
import path from "node:path";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // 每个响应都带上本进程的 PID —— 另一个实例据此认出「端口上坐着我自己」。
  app.use((_req, res, next) => {
    res.setHeader(INSTANCE_HEADER, String(process.pid));
    next();
  });
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // 健康检查：只回身份，不回业务数据。
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      pid: process.pid,
      port: process.env.PORT || "3000",
      // 项目根 —— 写出来是因为「写到了别的目录」这类问题**查不出来**：
      // 服务端启动时只说「last-report.json present」，
      // 不会说它读的是哪个目录。写出来一眼就能看出对不对。
      root: PROJECT_ROOT,
      reportFile: REPORT_FILE,
    });
  });
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerAgentRoutes(app);
  registerParameterProposalRoutes(app);
  // The confirmation page is a single static file under `web/`. It is served
  // ahead of the SPA fallback so it does not silently resolve to index.html.
  //
  // Matched by DECODED path, not by a route literal: express compares routes
  // against `req.path`, which is the raw — still percent-encoded — pathname.
  // So `app.get("/参数提议确认.html")` never fires for a browser or curl,
  // both of which send `/%E5%8F%82%E6%95%B0…`. The symptom was a 200 carrying
  // the SPA shell, i.e. a page that looks fine and is the wrong document.
  const CONFIRM_PAGE = path.resolve(PROJECT_ROOT, "web", "参数提议确认.html");
  const sendConfirmPage = (_req: unknown, res: any) => {
    // Explicit 404 rather than letting sendFile fall through to the SPA
    // fallback — otherwise a moved file reads as a working page.
    if (!nodeFs.existsSync(CONFIRM_PAGE)) {
      return res.status(404).send(`web/参数提议确认.html 不存在于 ${PROJECT_ROOT}`);
    }
    res.sendFile(CONFIRM_PAGE);
  };
  app.use((req, res, next) => {
    let decoded = req.path;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      /* 非法百分号编码：按原样比 */
    }
    if (decoded === "/参数提议确认.html" || req.path === "/proposals") return sendConfirmPage(req, res);
    next();
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");

  // 端口被**本项目的另一个实例**占着 → 响亮地拒绝启动。
  //
  // 原来的做法是静默换到下一个端口（3001、3002……），于是每起一个实例就多一个
  // 活着的进程，一个都不退出 —— 实测一次会话堆到了 39 个。
  // 而真正的伤害是：**你在浏览器里连的 3000 是最早那个旧实例**，
  // 它跑旧代码、还把报告写回同一份 last-report.json。
  // 「我刚跑出来的报告怎么还是旧的」—— 查起来毫无线索。
  //
  // 所以这里**不静默挪端口**：要么你把旧实例关掉，要么你明确换端口。
  const occupant = await probeOwnInstance(preferredPort);
  if (occupant && process.env.ALLOW_PORT_FALLBACK !== "1") {
    console.error(
      [
        "",
        `[启动失败] 端口 ${preferredPort} 已被**本项目的另一个实例**占用（PID ${occupant}）。`,
        "",
        "  在你浏览器里连的 3000 端口是**那个旧进程**：它跑的是旧代码，",
        "  你改了源码它不会重载，而且它还会把报告写回同一份 reports/last-report.json ——",
        "  于是「刚跑出来的报告怎么还是旧的」这种问题，在这里查不出任何线索。",
        "",
        "  先关掉它再启动：",
        `    taskkill /PID ${occupant} /F`,
        "",
        "  或给它/给自己换一个端口：",
        `    set PORT=3001 && npm run dev`,
        "",
        "  （确实想两个实例并存，就设 ALLOW_PORT_FALLBACK=1 —— 但要知道它们会抢同一份报告文件。）",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(
      `Port ${preferredPort} is busy, using port ${port} instead` +
        (occupant ? "（占用者是本项目的另一个实例，已设 ALLOW_PORT_FALLBACK=1）" : ""),
    );
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Report whether a previous run left a report behind, and which pipeline
    // produced it. /api/agent/report/last previously just 404'd with no clue
    // why the UI looked empty.
    try {
      const f = REPORT_FILE;
      if (nodeFs.existsSync(f)) {
        const st = nodeFs.statSync(f);
        let gen = "unknown";
        try {
          gen = JSON.parse(nodeFs.readFileSync(f, "utf-8")).generator ?? "unknown (pre-generator-tag)";
        } catch {
          /* unreadable — size is still useful */
        }
        console.log(`[reports] last-report.json present: ${st.size} bytes, generator=${gen}`);
      } else {
        console.log("[reports] no last-report.json yet — generate one before using /report/last or /report/trust");
      }
    } catch (e) {
      console.warn("[reports] could not probe last-report.json:", e);
    }
  });
}

startServer().catch(console.error);
