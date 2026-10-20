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
import { registerParameterProposalRoutes, PROJECT_ROOT } from "./parameterProposals";
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
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
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
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Report whether a previous run left a report behind, and which pipeline
    // produced it. /api/agent/report/last previously just 404'd with no clue
    // why the UI looked empty.
    try {
      const f = nodePath.resolve(import.meta.dirname, "../reports/last-report.json");
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
