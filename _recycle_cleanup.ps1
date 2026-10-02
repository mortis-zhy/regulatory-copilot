# Move section 3 & 4 files to the Recycle Bin
$root = 'C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main'
Add-Type -AssemblyName Microsoft.VisualBasic

$targets = @(
  # --- Section 3: logs / temp text ---
  'server-err.log',
  '.manus-logs',
  'api-stream-out.txt',
  'raw-stream.txt',
  'real-stream-out.txt',
  'sse-output.txt',
  'last-model-output.txt',
  'page-dom.txt',
  'full-content.txt',
  'ref_pdf_full.txt',
  'payload.json',
  'test-render.pdf',
  'comparison_agent_local_parser.zip',

  # --- Section 4: debug/test scripts ---
  'debug_dom.py',
  'debug_model_stream.py',
  'debug_pdf.py',
  'debug_request.py',
  'inspect_final.py',
  'inspect_payload.py',
  'inspect_report.mjs',
  'probe_dom.py',
  'probe_rate_limit.mjs',
  'api_real.mjs',
  'api_simple.mjs',
  'api_test.mjs',
  'test_clauses.mjs',
  'test_embed.mjs',
  'test_full_ui.py',
  'test_generate.mjs',
  'test_long.mjs',
  'test_long2.mjs',
  'test_long3.mjs',
  'test_pdf_detailed.py',
  'test_pdf_rules.mjs',
  'test_pdf_via_api.py',
  'test_rag_anything.mjs',
  'test_rag_api.py',
  'test_render.mjs',
  'verify_downloaded.py',
  'verify_pdf.py',
  'check_docs.py',
  'check-docs.mjs',
  'check_render.py',
  'fix_appendix.mjs',
  'fix_sentinel.py',
  'replace_prompt.py',
  'replace_prompt2.py',
  'dump_pdf.py',
  'find_ch15.py',
  'capture_stream.py',
  'stream_inspect.py',
  'render_last.mjs',
  'content_check.py',
  'final_e2e.py',
  'rag_parse.py',
  'read_ref_pdf.py',
  'demo.py'
)

$logPath = 'C:\Users\zsndz\Desktop\comparison_agent-main\_recycle_out.log'
$lines = @()
$moved = 0
$missing = @()
$failed = @()

foreach ($rel in $targets) {
  $path = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $path)) {
    $missing += $rel
    $lines += "SKIP(missing) $rel"
    continue
  }
  try {
    if (Test-Path -LiteralPath $path -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    $moved++
    $lines += "OK  $rel"
  } catch {
    $failed += $rel
    $lines += "FAIL $rel : $($_.Exception.Message)"
  }
}

$lines += "----"
$lines += "Moved: $moved  Missing: $($missing.Count)  Failed: $($failed.Count)"
$lines | Out-File -FilePath $logPath -Encoding UTF8
