# verify_all.ps1 -- one-shot verify pipeline
#
# Chain:
#   1. extract_aligned_tables.py -- extract markdown tables to structured JSON
#   2. fix_appendix_b.py         -- repair "(no title)" pollution in Appendix B
#   3. verify_pipeline.py        -- source PDF vs report JSON cross-check
#   4. (optional) re-render PDF
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File verify_all.ps1             # verify only
#   powershell -ExecutionPolicy Bypass -File verify_all.ps1 -Render     # verify + render hint
#   $env:SKIP_RENDER = "1"; powershell -File verify_all.ps1            # env-var skip
#
# Exit code: 0 = all pass, 1 = verify found failures
#
# Render step (PowerShell 5.1 has known Copy-Item bug on Chinese paths;
# this script does NOT directly overwrite target PDF). Manual command:
#   curl -X POST -H "Content-Type: application/json" `
#        -d @comparison_agent-main/reports/last-report.json `
#        -o GB4785_<multi-version>.pdf `
#        http://localhost:3000/api/agent/report/render

param([switch]$Render = $false)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

# 1. Extract aligned tables
Write-Host ""
Write-Host "==== 1. Extract aligned tables -> dist/aligned-tables.json ====" -ForegroundColor Cyan
python extract_aligned_tables.py
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] step 1" -ForegroundColor Red; exit $LASTEXITCODE }

# 2. Repair Appendix B title pollution
Write-Host ""
Write-Host "==== 2. Repair Appendix B title pollution ====" -ForegroundColor Cyan
python fix_appendix_b.py
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] step 2" -ForegroundColor Red; exit $LASTEXITCODE }

# 3. Cross-check source PDF vs report JSON
Write-Host ""
Write-Host "==== 3. Cross-check (source PDF vs last-report.json) ====" -ForegroundColor Cyan
python verify_pipeline.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] verify_pipeline.py reported failures" -ForegroundColor Yellow
    exit $LASTEXITCODE
}

# 4. (Optional) Render PDF
$skipRender = ($env:SKIP_RENDER -eq "1")
if ($Render -and -not $skipRender) {
    Write-Host ""
    Write-Host "==== 4. Render PDF ====" -ForegroundColor Cyan
    Write-Host "Run manually to avoid PowerShell 5.1 Chinese-path bug:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host '  curl -X POST -H "Content-Type: application/json" `' -ForegroundColor Cyan
    Write-Host '       -d @comparison_agent-main/reports/last-report.json `' -ForegroundColor Cyan
    Write-Host '       -o GB4785_<multi-version>.pdf `' -ForegroundColor Cyan
    Write-Host '       http://localhost:3000/api/agent/report/render' -ForegroundColor Cyan
    Write-Host ""
} elseif (-not $Render) {
    Write-Host ""
    Write-Host "(skipped render -- pass -Render for hint)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[OK] verify_all done." -ForegroundColor Green
