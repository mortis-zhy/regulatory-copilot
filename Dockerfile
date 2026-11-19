# 容器镜像 —— **运行时真的要 python** ✓
#
# 为什么改这个文件（2026-11-19）：
# 旧版只装了 node + 字体 ⇒ 容器里**抽不出图、裁不了字、跑不了自检** ✗
# （运行时**六处**调 python ✓：抽图 / 裁字 / 渲染自检 / MinerU sidecar / 参数抽取 / 表格抽取 ✓）
# ⇒ 交付件在容器里**出不来** ✗。现在把 python 与依赖装上 ✓。
#
# 另：旧版**没拷 data/ 与 scripts/** ✗ —— 项目根解析器认 `data/parameter-specs.json` ✓，
# 缺了它**启动即失败** ✗（报「找不到项目根」✓）。现在都拷上 ✓。
#
# 构建：
#   docker build -t regulatory-copilot .
#   docker run -p 3000:3000 --env-file .env -v /srv/copilot/uploads:/app/uploaded-docs \
#              -v /srv/copilot/reports:/app/reports regulatory-copilot
#
# **不需要 OCR 那层**（省 ~2 GB ✓）：
#   docker build --build-arg INSTALL_OCR=0 -t regulatory-copilot .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# PDF 渲染要中文字体 ✓（交付件全是中文 ✓）；
# **python3 + pip** ✓ —— 运行时六处要调它 ✓（见文件头 ✓）。
# **只用 gzip 的索引** ✓ —— 实测（2026-11-19，本机网络）：
#   Packages.xz 8.8 MB → **125 秒**（约 70 KB/s）✗ ⇒ 构建卡在这一步十几分钟 ✗；
#   Packages.gz 12 MB → **5 秒** ✓；不压缩的 Packages → 只回 300 字节（被拦）✗。
# 所以**强制 gzip** ✓ —— 不是洁癖，是**不让构建卡死** ✓。
RUN apt-get update -y \
      -o Acquire::CompressionTypes::Order::=gz \
      -o Acquire::Languages=none \
      -o Acquire::Retries=3 \
 && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
# **Python 依赖** ✓ —— 抽图 / 裁字 / 自检 / 抽取都靠它 ✓。
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
# **OCR 那层可选** ✓ —— torch ~2 GB ✓；默认**不装** ✓（省得每个容器 2 GB ✓）。
ARG INSTALL_OCR=0
COPY requirements-ocr.txt ./
RUN if [ "$INSTALL_OCR" = "1" ]; then \
      pip3 install --no-cache-dir --break-system-packages -r requirements-ocr.txt; \
    else \
      echo "[docker] 跳过 OCR 依赖（INSTALL_OCR=0）—— 图内数值那一列将没有 ✓"; \
    fi
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
# **脚本与数据** ✓ —— 少了 scripts/ ⇒ python 脚本全跑不了 ✗；
# 少了 data/ ⇒ **项目根解析不到 ⇒ 起不来** ✗；
# 少了 web/ ⇒ 「参数提议确认」那页 404 ✗。
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/data ./data
COPY --from=build /app/web ./web
# 语料与产物 —— 案例包的三份源 PDF ✓、图版与 OCR 结果 ✓（聊天层的图/表工具靠它们 ✓）。
COPY --from=build /app/uploaded-docs ./uploaded-docs
COPY --from=build /app/reports ./reports
# **端口** —— 与 .env.example 一致 ✓（以前是 8080 vs 3000 ⇒ 部署时对不上 ✗）。
ENV PORT=3000
EXPOSE 3000
# **健康检查** ✓ —— 容器编排靠它判死活 ✓；旧版没有 ⇒ 只能靠人盯 ✗。
HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
