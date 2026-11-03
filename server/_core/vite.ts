import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
// 项目根 —— **唯一实现**（server/_core/projectRoot.ts）。
import { PROJECT_ROOT } from "./projectRoot";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      // 从项目根算，不按本文件所在位置算（源码在 server/_core/，打包后在 dist/）。
      const clientTemplate = path.join(PROJECT_ROOT, "client", "index.html");

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  // 客户端构建目录 —— **从项目根算**，不按本文件所在位置算。
  //
  // 原来分两支：开发模式 `../..` + dist/public，发布模式 `import.meta.dirname/public`。
  // 两支的结果**其实是同一个目录**（`<root>/dist/public`）——
  // 既然如此，就没必要分两支，也没必要让路径依赖「自己在哪一层」。
  // 按位置算的路径是这个项目反复治的病（读到了别人的目录，还不报错）。
  const distPath = path.join(PROJECT_ROOT, "dist", "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
