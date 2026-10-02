/**
 * One-off test: structured extraction of the 3 real PDFs → programmatic diff.
 * Bundle: npx esbuild server/_diffTest.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/diff-test.mjs
 * Run:    node dist/diff-test.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import { extractStructured } from "./ingestion/structuredExtract";
import { diffDocuments } from "./reports/diffEngine";

const ROOT = "C:/Users/zsndz/Desktop/comparison_agent-main";
const PDFS: Array<{ label: string; path: string }> = [
  { label: "A", path: `${ROOT}/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf` },
  { label: "B", path: `${ROOT}/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf` },
  { label: "C", path: `${ROOT}/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf` },
];

function uploadPdf(filePath: string): Promise<{ fileName: string; text: string; pageCount: number }> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = filePath.split("/").pop()!;
  const boundary = "----B" + Math.random().toString(36).slice(2);
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const fname = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}`);
  const mime = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="mimeType"\r\n\r\napplication/pdf\r\n--${boundary}--\r\n`,
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path: "/api/agent/documents",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": header.length + fileBuffer.length + fname.length + mime.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve({ fileName, text: j.serverExtractedText || "", pageCount: j.serverPageCount || 0 });
          } catch (e) {
            reject(new Error("upload failed"));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(header);
    req.write(fileBuffer);
    req.write(fname);
    req.write(mime);
    req.end();
  });
}

async function main() {
  console.log("=== Step 1: 上传并提取三份 PDF 全文 ===");
  const texts: Record<string, { fileName: string; text: string }> = {};
  for (const p of PDFS) {
    const up = await uploadPdf(p.path);
    texts[p.label] = { fileName: up.fileName, text: up.text };
    console.log(`  ${p.label}: ${up.pageCount} 页, ${up.text.length.toLocaleString()} 字符`);
  }

  console.log("\n=== Step 2: 结构化提取（每份 1 次 LLM 调用，带缓存）===");
  const t0 = Date.now();
  const [sa, sb, sc] = await Promise.all([
    extractStructured("A", texts.A.fileName, texts.A.text),
    extractStructured("B", texts.B.fileName, texts.B.text),
    extractStructured("C", texts.C.fileName, texts.C.text),
  ]);
  console.log(`  完成，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const [label, s] of [["A", sa], ["B", sb], ["C", sc]] as const) {
    const withContent = s.topics.filter((t) => t.presence !== "no");
    console.log(
      `  ${label}《${s.docTitle.slice(0, 30)}》: ${s.topics.length} topics, ${withContent.length} 有内容, ` +
        `总 values=${s.topics.reduce((n, t) => n + t.values.length, 0)}`,
    );
  }

  console.log("\n=== Step 3: 程序化 diff（B→A，C 做参照）===");
  const diff = diffDocuments(sa, sb, sc);
  console.log(`  computed changes: ${diff.changes.length}`);
  console.log(`  computed parameters: ${diff.parameters.length}`);
  console.log("\n--- 变化清单（确定性，非 LLM 猜测）---");
  for (const c of diff.changes) {
    console.log(`\n[${c.type.toUpperCase()}] ${c.title}  (${c.severity})`);
    console.log(`  旧(B): ${c.oldExcerpt.slice(0, 140)}`);
    console.log(`  新(A): ${c.newExcerpt.slice(0, 140)}`);
    console.log(`  锚点: ${c.anchor}`);
  }

  fs.writeFileSync(
    "diff-result.json",
    JSON.stringify(
      { changes: diff.changes, valueDiffs: diff.valueDiffs, parameters: diff.parameters },
      null,
      2,
    ),
    "utf-8",
  );
  console.log("\n已保存 diff-result.json");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
