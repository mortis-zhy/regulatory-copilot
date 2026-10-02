/**
 * Render reports/last-report.json to a PDF via POST /api/agent/report/render
 * (no 20-minute regeneration needed — the report is persisted).
 */
import http from "http";
import fs from "fs";

const report = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
console.log(`Report: ${report.outline.title}`);
console.log(`  chapters: ${report.chapters.length}, appendices: ${(report.appendices || []).length}`);
for (const a of report.appendices || []) {
  const n = (a.markdown || "").replace(/[#*>\-\[\]()\s]/g, "").length;
  console.log(`  appendix ${a.id}: ${n} real chars${n < 200 ? " ← THIN" : ""}`);
}

const body = JSON.stringify(report);
const t0 = Date.now();
const req = http.request(
  {
    hostname: "localhost",
    port: 3000,
    path: "/api/agent/report/render",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const buf = Buffer.concat(chunks);
      console.log(`\nHTTP ${res.statusCode}, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${buf.length} bytes`);
      if (res.statusCode === 200 && buf.slice(0, 5).toString() === "%PDF-") {
        fs.writeFileSync("ui-test/render-final.pdf", buf);
        console.log(`✅ saved ui-test/render-final.pdf (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        console.log("❌", buf.toString().slice(0, 500));
      }
    });
  },
);
req.on("error", (e) => console.log("error:", e.message));
req.write(body);
req.end();
