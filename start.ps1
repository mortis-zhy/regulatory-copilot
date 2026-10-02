# 一键启动：Python sidecar (MinerU) + Node web 服务
# 用法：powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  法规对比智能体 — 启动脚本（v7.1 MinerU 确定性管线）" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. Python sidecar (MinerU 4.0.6 多模态提取 + verify) ----
Write-Host "[1/2] 启动 Python sidecar (端口 8300)..." -ForegroundColor Yellow
$sidecarRunning = Test-NetConnection -ComputerName 127.0.0.1 -Port 8300 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $sidecarRunning) {
    Start-Process -FilePath "python" -ArgumentList "python_service/main.py" -WorkingDirectory $Root -WindowStyle Hidden
    Write-Host "  sidecar 已启动（后台）" -ForegroundColor Green
} else {
    Write-Host "  sidecar 已在运行（跳过）" -ForegroundColor Green
}

# ---- 2. Node web 服务 ----
Write-Host "[2/2] 启动 Node web 服务 (端口 3000)..." -ForegroundColor Yellow
$env:NODE_ENV = "production"
Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $Root -NoNewWindow
Write-Host "  Web 服务已启动" -ForegroundColor Green
Write-Host ""
Write-Host "--------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  访问: http://localhost:3000" -ForegroundColor White
Write-Host "  sidecar health: http://127.0.0.1:8300/health" -ForegroundColor White
Write-Host "  MinerU 报告: POST /api/agent/report/generate/mineru" -ForegroundColor White
Write-Host "--------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host "提示：模型权重已在本机 .mineru-models/（~854MB），全程零外网依赖。" -ForegroundColor DarkGray