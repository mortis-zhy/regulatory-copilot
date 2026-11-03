/**
 * The INNER repo root — the one holding dist/, diff-result.json, data/ and the
 * Python helpers (verify_claims.py, extract_toc_pages.py, add_pdf_outline.py).
 *
 * Why this is a shared module and not a local `path.resolve(import.meta.dirname, "../..")`
 * ---------------------------------------------------------------------------
 * Bundled to `dist/index.js`, `import.meta.dirname` is `<inner>/dist`, so
 * `"../.."` resolves to the **OUTER** workbench repo — one level too far.
 * That mis-resolution already caused three silent degradations:
 *   - §11.3.3 参数对照矩阵 rendered empty
 *   - add_pdf_outline.py was never found (PDF bookmarks silently dropped)
 *   - the TOC two-pass aborted
 * and later a fourth: the §11.9 定性义务清单 fell back to its
 * "data unavailable" branch and the delivered PDF said nothing about it.
 *
 * Walk **up** from the module until we find the marker file instead of
 * assuming a fixed depth. COMPARE_AGENT_ROOT still wins when set.
 *
 * Sharing it matters: two copies of this function drift. The second copy is
 * where the §11.9 bug came from.
 */
import fs from "node:fs";
import path from "node:path";

export function resolveInnerRoot(): string {
  if (process.env.COMPARE_AGENT_ROOT) return path.resolve(process.env.COMPARE_AGENT_ROOT);
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "verify_claims.py"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(import.meta.dirname, "../..");
}
