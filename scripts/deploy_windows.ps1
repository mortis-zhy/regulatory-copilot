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

  ## ⚠ **本文件必须带 UTF-8 BOM** ✓

  PowerShell 5.1 读 `.ps1` 时，**没有 BOM 就按 ANSI（GBK）读** ✓ ⇒ 里面的中文全变乱码 ✓
  ⇒ 引号被吃掉 ⇒ **语法错** ✗（实测 2026-11-19：服务器上第一次跑就报 ParserError ✗）。
  ⇒ **别把 BOM 去掉** ✓（闸门会查 ✓）。

  ## 用法（在服务器上，或从这台机器 SSH 过去跑）

  ```powershell
  # 最省事：让服务器自己去 GitHub 拉源码（实测 github.com 从服务器 0.4s ✓）
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\gea\deploy_windows.ps1
  ```
#>
param(
  [string]$InstallDir = "C:\gea\regulatory-copilot",
  # **逐文件**拉取用这两个 base ✓ ——
  #   jsDelivr 实测 **0.21 MB/s** ✓（比 raw 稳 ✓）；
  #   raw 实测会**超时**（curl code 28 ✗）⇒ 只作**兜底** ✓。
  [string]$RepoJsDelivr = "https://cdn.jsdelivr.net/gh/mortis-zhy/regulatory-copilot",
  [string]$RepoRawBase  = "https://raw.githubusercontent.com/mortis-zhy/regulatory-copilot/main",
  [string]$WorkDir    = "C:\gea\rc-build",
  [int]$Port         = 3000,
  [switch]$SkipDownload,
  [switch]$SkipBuild,
  [switch]$WithOcr,
  [string]$TaskName  = "GEA-Regulatory"
)

$ErrorActionPreference = "Stop"
# **日志同时写文件** ✓ —— stdout 被重定向时是**缓冲**的 ✗（实测：跑了几分钟日志还是空的 ✗），
# 挂在文件上才看得到进度 ✓。
$ProgressLog = "C:\gea\deploy.log"
function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
  Write-Output $line
  try { Add-Content -Path $ProgressLog -Value $line -Encoding UTF8 } catch { }
}

Say "=== 部署开始（目标：$InstallDir，端口 $Port）==="

# ── 1. 环境自检（先把话说清楚：缺什么就报错，别装到一半才发现）──────────
$node = (Get-Command node.exe -EA SilentlyContinue).Source
if (-not $node) { throw "**没有 node** ✗ —— 装个 Node 20+ 再来 ✓" }

# **python 不能只靠 PATH** ✓ —— 计划任务跑在 **SYSTEM** 账号下 ✗，
# 它的 PATH 里**没有**各用户的 Python ✓（实测 2026-11-19：第一次跑就报「没有 python」✗）。
# ⇒ 依次找：PATH → `py.exe` → **各用户目录下的固定位置** ✓。
$py = (Get-Command python.exe -EA SilentlyContinue).Source
if (-not $py) {
  $pyLauncher = (Get-Command py.exe -EA SilentlyContinue).Source
  if ($pyLauncher) { $py = $pyLauncher }
}
if (-not $py) {
  foreach ($pat in @(
      "C:\Users\*\AppData\Local\Programs\Python\Python3*\python.exe",
      "C:\Python3*\python.exe",
      "C:\Program Files\Python3*\python.exe")) {
    $hit = Get-ChildItem $pat -EA SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($hit) { $py = $hit.FullName; break }
  }
}
if (-not $py) { throw "**没有 python** ✗ —— 装个 Python 3.10+ 再来 ✓" }

Say ("node=" + (& node --version 2>&1))
Say ("python=" + (& $py --version 2>&1))
Say ("python_path=" + $py)

# **下载要重试 + 要超时** ✓ —— 实测（2026-11-19，两个坑）：
#   · raw 偶发「连接被关闭：传输请求被中止」✗ ⇒ 一次失败就放弃 ⇒ 白跑几十分钟 ✗；
#   · **Invoke-WebRequest 会「挂住」** ✗ —— 连接建立后一个字节都不来，
#     `-TimeoutSec` **管不住它** ✗（实测：一个 0.1 MB 的小文件卡了 **16 分钟** ✗），
#     而 **curl.exe 有 `--max-time`** ✓ ⇒ 换 curl ✓（Windows 10+ 自带 ✓）。
function Fetch-File($url, $dest, $tries = 6) {
  $curl = Get-Command curl.exe -EA SilentlyContinue
  if ($curl) {
    for ($i = 1; $i -le $tries; $i++) {
      # **curl 往 stderr 写一行错误 ⇒ 在 `$ErrorActionPreference="Stop"` 下 PowerShell
      # 会把它当**异常抛出来** ✗（实测：`curl: (56) Recv failure` 直接终止整个部署 ✗）。
      # ⇒ 调 curl 时把偏好降下来 ✓，**只看 curl 自己的退出码** ✓。
      $prev = $ErrorActionPreference
      $ErrorActionPreference = "SilentlyContinue"
      # **大文件要更长的超时** ✓ —— 那台机器到 raw 的实测带宽只有 **37 KB/s** ✗
      # （5 MB 的源 PDF 要 **135 秒** ✓，而 `--max-time 180` 刚好卡在边上 ✗ ⇒ 4 次全失败 ✗）。
      # ⇒ 给 **900 秒** ✓，并且 curl 自己再重试 2 次 ✓（连接被重置是常态 ✓）。
      & $curl.Source -sS -L --fail --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 900 -o $dest $url 2>$null
      $code = $LASTEXITCODE
      $ErrorActionPreference = $prev
      if ($code -eq 0) { return $true }
      Start-Sleep -Seconds (2 * $i)
    }
    Say ("下载失败 {0}（curl 重试 {1} 次）✗" -f $url, $tries)
    return $false
  }
  $ProgressPreference = "SilentlyContinue"
  for ($i = 1; $i -le $tries; $i++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 120 -UseBasicParsing
      return $true
    } catch {
      Start-Sleep -Seconds (2 * $i)
    }
  }
  Say ("下载失败 {0}（重试 {1} 次）✗" -f $url, $tries)
  return $false
}

# **原生命令的统一调用口** ✓ —— 只看**退出码** ✓，不看 stderr ✓。
# 为什么：`$ErrorActionPreference = "Stop"` 下，原生命令往 stderr 写一行
# （pnpm 的 "deprecated … vulnerabilities"、pip 的进度条 ✗）就会**抛异常终止整个部署** ✗
# —— 实测在服务器上踩过两次 ✓（curl 的 "Recv failure" ✓、pnpm 的警告 ✓）。
function Invoke-Native($exe, $argList, $logPath) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & $exe @argList 2>&1 | Tee-Object -FilePath $logPath | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}

# ── 2. 取源码（**逐个文件**从 raw 拉 ✓ —— 整仓 zip 太慢 ✗）──────────────
#
# 实测（2026-11-19）：整仓 zip（codeload）**37 KB/s** ✗（300 MB 要几小时 ✗）；
# 单个文件（raw）**3.1 MB/s** ✓ ⇒ 逐个拉 ✓（315 个文件 · 22.5 MB ✓）。
# 清单 `deploy/manifest.txt` 带 **sha256** ✓ ⇒ 拉完逐个核对 ✓。
if (-not $SkipDownload) {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $src = Join-Path $WorkDir "src"
  # **不删已拉的文件** ✓ —— 重跑时按 sha 跳过 ✓（每个文件一次请求 ⇒ 一次要 25 分钟 ✗）。
  New-Item -ItemType Directory -Force -Path $src | Out-Null

  $manifestPath = Join-Path $src "manifest.txt"
  # **清单本身**先试 **raw@main** ✓ —— jsDelivr 对分支**有缓存** ✗
  # （实测：它给的是**旧一版**清单 ⇒ 少了 patches/ ⇒ `pnpm install` ENOENT ✗）；
  # raw 慢（实测 3.5 分钟 ✓）但**一定是当前版** ✓。jsDelivr 作兜底 ✓。
  $manifestUrls = @("$RepoRawBase/deploy/manifest.txt", "$RepoJsDelivr@main/deploy/manifest.txt")
  $got = $false
  foreach ($u in $manifestUrls) {
    if (Fetch-File $u $manifestPath 3) { $got = $true; break }
  }
  if (-not $got) { throw "取部署清单失败 ✗（两个源都试过了 ✗）" }
  $manifestLines = Get-Content $manifestPath -Encoding UTF8
  $commit = ""
  foreach ($l in $manifestLines) { if ($l -match "^#\s*commit\s+([0-9a-f]{40})") { $commit = $matches[1]; break } }
  if (-not $commit) { throw "清单里没有 commit 号 ✗ —— 服务器会拿到**不确定哪一版**的源码 ✗" }
  $manifest = $manifestLines | Where-Object { $_ -and -not $_.StartsWith("#") }
  Say ("清单 {0} 个文件 ✓（commit {1} ✓）" -f $manifest.Count, $commit.Substring(0, 8))

  $i = 0
  foreach ($line in $manifest) {
    $i++
    $parts = $line -split "\s+", 2
    if ($parts.Count -lt 2) { continue }
    $sha = $parts[0].Trim()
    $rel = $parts[1].Trim()
    $enc = ($rel -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/"
    $dest = Join-Path $src $rel
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # **已经对上了就不重下** ✓ —— 重跑部署时省掉几百次请求 ✓（实测一次要 25 分钟 ✗）。
    if ((Test-Path $dest) -and ((Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower() -eq $sha.ToLower())) {
      if ($i % 50 -eq 0) { Say ("已核对 {0}/{1} 个（跳过重下 ✓）" -f $i, $manifest.Count) }
      continue
    }
    # **钉住 commit** ✓ ⇒ 不会拿到 CDN 缓存里的旧版 ✗；两个源都试 ✓。
    $urls = @("$RepoJsDelivr@$commit/$enc", "$RepoRawBase/$commit/$enc")
    $ok2 = $false
    foreach ($u in $urls) { if (Fetch-File $u $dest 3) { $ok2 = $true; break } }
    if (-not $ok2) { throw "拉源码失败（{0}）✗" -f $rel }
    $got2 = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
    if ($got2 -ne $sha.ToLower()) { throw ("**sha256 不符**：{0} ✗（下载损坏 ✗）" -f $rel) }
    if ($i % 50 -eq 0) { Say ("已拉并核对 {0}/{1} 个 ✓" -f $i, $manifest.Count) }
  }
  Say ("源码全部拉完并**逐个核对 sha256** ✓（{0} 个文件 ✓）" -f $manifest.Count)

  if (Test-Path $InstallDir) {
    Say "旧的 $InstallDir 保留（不删 ✓ —— 删了就没法回滚 ✗）"
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # 复制源码（robocopy 比 Copy-Item 稳 ✓ —— 大目录 ✓）
  robocopy $src $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）✗" }
  Say "源码已就位：$InstallDir"
}

if (-not (Test-Path $InstallDir)) { throw "没有 $InstallDir ✗" }

# ── 3. Node 依赖 + 构建（**npm.cmd** ⇒ 绕开执行策略 ✓）─────────────────────
if (-not $SkipBuild) {
  Push-Location $InstallDir
  # **原生命令往 stderr 写一行 ⇒ 在 `$ErrorActionPreference="Stop"` 下会被当异常抛出来** ✗
  # （实测：pnpm 打完 "deprecated … vulnerabilities" 就把整个部署**终止**了 ✗）——
  # 那是**警告**不是失败 ✗ ⇒ 调原生命令时把偏好降下来 ✓，**只看退出码** ✓（见 Invoke-Native ✓）。
  # **用 pnpm** ✓ —— 仓库的锁文件是 `pnpm-lock.yaml` ✓，
  # 而 `npm install` 会**重新解依赖** ⇒ 实测直接 **ERESOLVE** ✗（peer 冲突 ✗）。
  # corepack（node 自带 ✓）能装出与本地**同一个** pnpm ✓ ⇒ 装出来的东西一样 ✓。
  Say "装 pnpm（corepack ✓ —— 与仓库的 pnpm-lock.yaml 对齐 ✓）"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & corepack enable 2>&1 | Out-Null
  & corepack prepare pnpm@10.4.1 --activate 2>&1 | Out-Null
  $ErrorActionPreference = $prev
  $pnpmCmd = (Get-Command pnpm.cmd -EA SilentlyContinue).Source
  if ($pnpmCmd) {
    Say "pnpm install --frozen-lockfile ✓"
    if ((Invoke-Native $pnpmCmd @("install", "--frozen-lockfile") (Join-Path $WorkDir "npm-install.log")) -ne 0) {
      throw "pnpm install 失败 ✗（看 $WorkDir\npm-install.log）"
    }
    Say "pnpm run build ✓"
    if ((Invoke-Native $pnpmCmd @("run", "build") (Join-Path $WorkDir "npm-build.log")) -ne 0) {
      throw "pnpm run build 失败 ✗（看 $WorkDir\npm-build.log）"
    }
  } else {
    Say "npm install --legacy-peer-deps ✓（没有 pnpm ⇒ 退回 npm ✓）"
    if ((Invoke-Native "npm.cmd" @("install", "--no-audit", "--no-fund", "--legacy-peer-deps") (Join-Path $WorkDir "npm-install.log")) -ne 0) {
      throw "npm install 失败 ✗（看 $WorkDir\npm-install.log）"
    }
    Say "npm run build ✓"
    if ((Invoke-Native "npm.cmd" @("run", "build") (Join-Path $WorkDir "npm-build.log")) -ne 0) {
      throw "npm run build 失败 ✗（看 $WorkDir\npm-build.log）"
    }
  }
  Pop-Location
  Say "构建完成 ✓"
}

# ── 4. Python 依赖（抽图 / 裁字 / 自检 / 抽取都靠它 ✓）───────────────────
Push-Location $InstallDir
# **用国内镜像** ✓ —— 实测：从 pypi.org 直连，下 63 MB 的 PyMuPDF 用了 **13 分钟** ✗；
# 清华镜像实测快一个量级 ✓。官方源留作兜底 ✓。
Say "pip install -r requirements.txt（清华镜像 ✓）"
$pipArgs = @("-m", "pip", "install", "--no-warn-script-location",
  "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
  "-r", "requirements.txt")
if ((Invoke-Native $py $pipArgs (Join-Path $WorkDir "pip.log")) -ne 0) {
  Say "清华镜像失败 ⇒ 退回官方源 ✗"
  if ((Invoke-Native $py @("-m", "pip", "install", "--no-warn-script-location", "-r", "requirements.txt") (Join-Path $WorkDir "pip.log")) -ne 0) {
    throw "pip install 失败 ✗（看 $WorkDir\pip.log）"
  }
}
if ($WithOcr) {
  Say "pip install -r requirements-ocr.txt（torch ~2 GB ⇒ 慢 ✓）"
  if ((Invoke-Native $py $pipArgs (Join-Path $WorkDir "pip-ocr.log")) -ne 0) {
    Say "OCR 依赖没装上 ✗ ⇒「图内数值（OCR）」那一列没有 ✓（其余照常 ✓）"
  }
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
