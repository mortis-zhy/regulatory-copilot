# verify_all.ps1 -- optional diagnostics runner
#
# ARCHITECTURE NOTE (v8.6.0+):
#   The PDF render pipeline is now fully self-contained in TypeScript. No
#   Python script is required to produce a correct PDF:
#     - table extraction / row normalization / triptych classification
#       -> server/reports/typedTables.ts (in-process, during buildHtml)
#     - trust checks (dual-source / false-diff / renumber / C-placeholder)
#       -> server/reports/trustChecks.ts (in-process, via /api/agent/report/trust)
#     - extraction-failure placeholders
#       -> rendered with a loud .cell-placeholder style in htmlRenderV8.ts
#
#   The Python scripts in this directory are therefore OPTIONAL tooling:
#     verify_pipeline.py       adds source-PDF cross-checks (page counts,
#                              voltages, clause pages, units) that need PyMuPDF
#                              and the three original files
#     extract_aligned_tables.py  writes dist/aligned-tables.json, which is now
#                              only a fallback the renderer never needs
#     fix_appendix_b.py       back-fills real figure titles from source PDFs;
#                              the renderer already flags unfilled cells
#
# Run this script when you want the PDF-vs-source cross-check. Skip it for a
# normal generate -> render cycle.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File verify_all.ps1
#
# Exit code: 0 all pass, 1 verify found failures

param([switch]$Render = $false)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

# 1. Optional: write the legacy typed-table bundle (fallback only)
Write-Host ""
Write-Host "==== [optional] dist/aligned-tables.json (fallback bundle) ====" -ForegroundColor DarkGray
python extract_aligned_tables.py
if ($LASTEXITCODE -ne 0) { Write-Host "[warn] step 1 skipped" -ForegroundColor Yellow }

# 2. Optional: back-fill appendix B figure titles from the source PDFs
Write-Host ""
Write-Host "==== [optional] appendix B figure titles ====" -ForegroundColor DarkGray
python fix_appendix_b.py
if ($LASTEXITCODE -ne 0) { Write-Host "[warn] step 2 skipped" -ForegroundColor Yellow }

# 3. Source-PDF cross-check (the only part that genuinely needs Python)
Write-Host ""
Write-Host "==== source PDF cross-check (needs PyMuPDF + 3 original files) ====" -ForegroundColor Cyan
python verify_pipeline.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] verify_pipeline.py reported failures" -ForegroundColor Yellow
    exit $LASTEXITCODE
}

# 4. In-process trust checks (always available via the API)
Write-Host ""
Write-Host "==== in-process trust checks (TS, no Python needed) ====" -ForegroundColor Cyan
try {
    $trust = Invoke-RestMethod -Uri "http://localhost:3000/api/agent/report/trust" -TimeoutSec 10
    Write-Host ("  closure: " + ($trust.dashboard | ConvertTo-Json -Compress))
    Write-Host ("  errata: " + $trust.errata.Count + " | rumors: " + $trust.rumors.Count)
    foreach ($w in $trust.warnings) {
        Write-Host ("  [" + $w.status + "] " + $w.label + " -- " + $w.detail)
    }
} catch {
    Write-Host "[warn] server not reachable on :3000 -- skip in-process checks" -ForegroundColor DarkGray
}

# 5. Optional render hint
if ($Render) {
    Write-Host ""
    Write-Host "==== render hint ====" -ForegroundColor Cyan
    Write-Host "Run manually (PowerShell 5.1 Chinese-path bug):" -ForegroundColor Yellow
    Write-Host "  curl -X POST -H ""Content-Type: application/json"" ``"
    Write-Host "       -d @comparison_agent-main/reports/last-report.json ``"
    Write-Host "       -o GB4785_report.pdf ``"
    Write-Host "       http://localhost:3000/api/agent/report/render" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[OK] verify_all done." -ForegroundColor Green