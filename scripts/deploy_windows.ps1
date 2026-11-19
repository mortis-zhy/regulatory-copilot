<#
  部署到 **Windows** 服务器（公司那台 `asda`）✓ —— 幂等 ✓，可重复跑 ✓。

  ## 为什么是 **Windows 原生** 而不是 Docker

  目标机是 Windows 10 ✓（实测：node v24 ✓ · python 3.12 ✓ · **没有 git** ✓ · **没有 Chrome，只有 Edge** ✓）。
  走 Docker 要先装 Docker Desktop（要 WSL2、要重启、要管理员）✗ ⇒ 原生更快 ✓。

  ## 这份脚本踩过的坑（都来自 2026-11-18 的远程部署经验 ✓）

  1. **`npm` 会被执行策略拦** ✗（`npm.ps1` ⇒ `无法加载文件…系统禁止运行脚本` ✗）
     ⇒ 一律用 **`npm.cmd`** ✓（绕开 .ps1 包装 ✓）；
  2. **长任务不能挂在 SSH 会话里** ✗（断线即中断 ✓）
     ⇒ 本脚本用 `Start-Process cmd.exe /c … > log` **脱离会话** ✓，再轮询日志 ✓；
  3. **开机自启必须有 AtStartup 触发器** ✗（只有「登录时」触发 ⇒ 重启后不启动 ✓）
     ⇒ 注册计划任务时显式加 `-Trigger (New-ScheduledTaskTrigger -AtStartup)` ✓；
  4. **机器会睡** ✗（睡了就没人访问 ⇒ 站点看着像挂了 ✓）
     ⇒ 顺手把休眠/睡眠关掉 ✓；
  5. **PowerShell 传脚本会被 BOM 吃掉第一行** ✗
     ⇒ 调用方请用 **`-EncodedCommand`**（UTF-16LE Base64）✓ —— 本文件本身是 UTF-8 ✓。

  ## 用法（在服务器上，或从这台机器 SSH 过去跑）

  ```powershell
  # 最省事：让服务器自己去 GitHub 拉源码（实测 github.com 从服务器 0.4s ✓）
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\gea\deploy_windows.ps1
  ```
#>
param(
  [string]$InstallDir = "C:\gea\regulatory-copilot",
  [string]$RepoZipUrl = "https://github.com/mortis-zhy/regulatory-copilot/archive/refs/heads/main.zip",
  [string]$WorkDir    = "C:\gea\rc-build",
  [int]$Port         = 3000,
  [switch]$SkipDownload,
  [switch]$SkipBuild,
  [switch]$WithOcr,
  [string]$TaskName  = "GEA-Regulatory"
)

$ErrorActionPreference = "Stop"
function Say($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }
function Step($m) { Say $m; Write-Output $m }

Say "=== 部署开始（目标：$InstallDir，端口 $Port）==="

# ── 1. 环境自检（先把话说清楚：缺什么就报错，别装到一半才发现）──────────
$node = (Get-Command node.exe -EA SilentlyContinue).Source
$py   = (Get-Command python.exe -EA SilentlyContinue).Source
if (-not $node) { throw "**没有 node** ✗ —— 装个 Node 20+ 再来 ✓" }
if (-not $py)   { throw "**没有 python** ✗ —— 装个 Python 3.10+ 再来 ✓" }
Say ("node=" + (& node --version 2>&1))
Say ("python=" + (& py --version 2>&1))

# ── 2. 取源码（服务器自己能连 GitHub ✓ ⇒ 不走隧道传 1 GB ✗）─────────────
if (-not $SkipDownload) {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $zip = Join-Path $WorkDir "repo.zip"
  Say "下载源码：$RepoZipUrl"
  # 下载可能慢（仓库里带交付件 PDF ✓）⇒ 给足超时 ✓
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zip -TimeoutSec 1800 -UseBasicParsing
  Say ("下载完成：{0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
  $tmp = Join-Path $WorkDir "unpack"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not $root) { throw "解压后没找到源码目录 ✗" }
  # **交付件 PDF 在服务器上用不到** ✗ ⇒ 删掉省空间 ✓（几十 MB ✓）
  if (Test-Path (Join-Path $root.FullName "delivery")) {
    Remove-Item -Recurse -Force (Join-Path $root.FullName "delivery")
    Say "已删掉 delivery/（服务器上用不到 ✓）"
  }
  if (Test-Path $InstallDir) {
    Say "旧的 $InstallDir 保留（不删 ✓ —— 删了就没法回滚 ✗）"
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # 复制源码（robocopy 比 Copy-Item 稳 ✓ —— 大目录 ✓）
  robocopy $root.FullName $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）✗" }
  Say "源码已就位：$InstallDir"
}

if (-not (Test-Path $InstallDir)) { throw "没有 $InstallDir ✗" }

# ── 3. Node 依赖 + 构建（**npm.cmd** ⇒ 绕开执行策略 ✓）─────────────────────
if (-not $SkipBuild) {
  Push-Location $InstallDir
  Say "npm install（用 npm.cmd ✓ —— npm.ps1 会被执行策略拦 ✗）"
  & npm.cmd install --no-audit --no-fund 2>&1 | Tee-Object -FilePath (Join-Path $WorkDir "npm-install.log") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败 ✗（看 $WorkDir\npm-install.log）" }
  Say "npm run build"
  & npm.cmd run build 2>&1 | Tee-Object -FilePath (Join-Path $WorkDir "npm-build.log") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm run build 失败 ✗（看 $WorkDir\npm-build.log）" }
  Pop-Location
  Say "构建完成 ✓"
}

# ── 4. Python 依赖（抽图 / 裁字 / 自检 / 抽取都靠它 ✓）───────────────────
Push-Location $InstallDir
Say "pip install -r requirements.txt"
& $py -m pip install --no-warn-script-location -r requirements.txt 2>&1 | Tee-Object -FilePath (Join-Path $WorkDir "pip.log") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pip install 失败 ✗（看 $WorkDir\pip.log）" }
if ($WithOcr) {
  Say "pip install -r requirements-ocr.txt（torch ~2 GB ⇒ 慢 ✓）"
  & $py -m pip install --no-warn-script-location -r requirements-ocr.txt 2>&1 | Tee-Object -FilePath (Join-Path $WorkDir "pip-ocr.log") | Out-Null
  if ($LASTEXITCODE -ne 0) { Say "OCR 依赖没装上 ✗ ⇒「图内数值（OCR）」那一列没有 ✓（其余照常 ✓）" }
}
Pop-Location

# ── 5. .env（**没就写一份模板** ✓ —— key 由人填 ✓）────────────────────────
$envFile = Join-Path $InstallDir ".env"
if (-not (Test-Path $envFile)) {
  $lines = @(
    "# 部署配置（2026-11-19 由 deploy_windows.ps1 生成 ✓）",
    "PORT=$Port",
    "NODE_ENV=production",
    "# 服务器上**只有 Edge** ✓ ⇒ 渲染用 Edge ✓（不配就渲染失败 ✗）",
    "PLAYWRIGHT_CHANNEL=msedge",
    "# 中文字体：微软雅黑 ✓（Windows 自带 ✓）",
    "REPORT_FONT_PATH=C:\Windows\Fonts\msyh.ttc",
    "# 会话签名：随机串 ✓（下面这行是自动生成的 ✓）",
    ("JWT_SECRET=" + [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")),
    "# 模型凭据：把 key 填进来 ✓（形如 minimax|sk-cp-…|https://api.minimax.cn|MiniMax-M3）",
    "MODEL_KEY_POOL=",
    "MINIMAX_API_KEY=",
    "MINIMAX_BASE_URL=https://api.minimax.cn",
    "MINIMAX_MODEL=MiniMax-M3",
    "# 数据库：不填走 in-memory ⇒ **重启丢数据** ✗",
    "DATABASE_URL="
  )
  Set-Content -Path $envFile -Value $lines -Encoding UTF8
  Say "已生成 .env（**key 要人填** ✓ —— 绝不写进仓库 ✓）"
} else {
  Say ".env 已存在 ⇒ 不覆盖 ✓"
}

# ── 6. 启动脚本（**日志落盘** ✓ —— 没有日志等于没部署 ✗）────────────────
$logDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$cmdPath = Join-Path $InstallDir "run_server.cmd"
$cmd = @(
  "@echo off",
  "cd /d $InstallDir",
  "set PORT=$Port",
  "set NODE_ENV=production",
  "if not exist logs mkdir logs",
  "node dist\index.js >> logs\server.log 2>&1",
  "exit /b %errorlevel%"
)
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
Say "启动脚本：$cmdPath"

# ── 7. 开机自启（**AtStartup 触发器** ✓ —— 少了它重启后不启动 ✗）──────────
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmdPath`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
if (Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Say "计划任务已注册：$TaskName（SYSTEM / 最高权限 / AtStartup ✓）"

# ── 8. 别让机器睡（睡了就等于服务挂了 ✗）───────────────────────────────
try {
  & powercfg /change standby-timeout-ac 0 | Out-Null
  & powercfg /hibernate off | Out-Null
  Say "已关掉自动睡眠与休眠 ✓（睡了就没人访问 ✗）"
} catch {
  Say "改电源设置失败（不影响服务 ✓）"
}

# ── 9. 启动 + 健康检查 ────────────────────────────────────────────────
Say "启动服务…"
Start-ScheduledTask -TaskName $TaskName
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
      Say "健康检查通过 ✓ → $($r.Content)"
      $ok = $true
      break
    }
  } catch { }
}
if (-not $ok) {
  Say "**健康检查没通过** ✗ —— 看日志："
  if (Test-Path (Join-Path $logDir "server.log")) { Get-Content (Join-Path $logDir "server.log") -Tail 40 }
  throw "服务没起来 ✗（日志见上 ✓）"
}

# ── 10. 部署自检（**这台机器上能不能出交付件** ✓）────────────────────────
Say "跑部署自检 scripts/check_deploy.py"
Push-Location $InstallDir
& $py scripts\check_deploy.py
Pop-Location

Say "=== 部署完成 ✓ ==="
Say "本机访问：http://127.0.0.1:$Port"
Say "局域网/Tailscale：http://<服务器IP>:$Port"
Say "日志：$logDir\server.log"
