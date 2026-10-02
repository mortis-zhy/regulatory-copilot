/**
 * One-off quality patch: regenerate any appendix whose markdown is
 * near-empty (< 200 real chars) directly against MiniMax, then write the
 * fixed report back to reports/last-report.json.
 */
import http from "http";
import https from "https";
import fs from "fs";

// ---------- 1. re-extract the three demo PDFs ----------
const PDFS = [
  "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
  "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
  "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
];
const LABELS = ["A", "B", "C"];

function uploadPdf(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = filePath.split("/").pop();
  const boundary = "----B" + Math.random().toString(36).slice(2);
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const fname = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}`);
  const mime = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="mimeType"\r\n\r\napplication/pdf\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost", port: 3000, path: "/api/agent/documents", method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": header.length + fileBuffer.length + fname.length + mime.length },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data).serverExtractedText || ""); }
        catch (e) { reject(new Error("bad upload response")); }
      });
    });
    req.on("error", reject);
    req.write(header); req.write(fileBuffer); req.write(fname); req.write(mime); req.end();
  });
}

// ---------- 2. call MiniMax directly (streamed so long output isn't truncated) ----------
function streamChat(prompt) {
  const key = (fs.readFileSync(".env", "utf8").match(/MINIMAX_API_KEY=(.+)/) || [])[1].trim();
  const body = JSON.stringify({
    model: "MiniMax-M3",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8192,
    temperature: 0.3,
    stream: true,
    thinking: { type: "adaptive" },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.minimax.cn",
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let full = "", buffer = "";
      if (res.statusCode !== 200) {
        let e = "";
        res.on("data", (c) => (e += c));
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${e.slice(0, 200)}`)));
        return;
      }
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim();
          if (p === "[DONE]") { resolve(full); return; }
          try {
            const j = JSON.parse(p);
            const d = j.choices?.[0]?.delta;
            if (d?.reasoning_content) continue;
            if (d?.content) full += d.content;
          } catch {}
        }
      });
      res.on("end", () => resolve(full));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // Upload docs
  console.log("Extracting 3 PDFs…");
  const docs = [];
  for (let i = 0; i < PDFS.length; i++) {
    const text = await uploadPdf(PDFS[i]);
    docs.push({ label: LABELS[i], text });
    console.log(`  ${LABELS[i]}: ${text.length} chars`);
  }

  // Load report, find thin appendices
  const report = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
  const thin = (report.appendices || []).filter(
    (a) => (a.markdown || "").replace(/[#*>\-\[\]()\s]/g, "").length < 200,
  );
  console.log(`\nThin appendices: ${thin.map((a) => a.id).join(", ") || "none"}`);
  if (!thin.length) { console.log("Nothing to fix."); return; }

  const chapterList = (report.outline.chapters || []).map((c) => `${c.id} ${c.title}`).join("；");

  for (const ap of thin) {
    console.log(`\nRegenerating appendix ${ap.id} — ${ap.title}`);
    const docText = docs.map((d) => `===== 文档 ${d.label} =====\n${d.text}`).join("\n\n");
    const prompt = `你是资深法规对比研究员。请为《${report.outline.title}》撰写"附录 ${ap.id} ${ap.title}"。

【报告章节结构（供交叉引用）】
${chapterList}

【要求】
1. 这是数据型附录：输出**大表格**（markdown 表格），集中汇总散落数据
2. 附录类型提示：
   - 章节结构对照表 → 三列（A草案/B 2019/C UN R48）逐章对照
   - 关键数值差异 → 数值 | A值 | B值 | C值 | 差异说明，至少 15 行
   - 术语对照 → 中文 | 英文 | A出现位置 | B出现位置，至少 15 行
   - 数据溯源 → 条款号 | 原始 PDF 页码 | 版本批次，列出 20+ 条
3. 每条数据带原文锚点（条款号/页码）
4. 800~2000 字，直接输出 markdown，禁止只写标题

【三份法规全文】
${docText}

现在直接输出附录 ${ap.id} 的 markdown 正文：`;

    try {
      const md = await streamChat(prompt);
      const realLen = md.replace(/[#*>\-\[\]()\s]/g, "").length;
      console.log(`  → ${md.length} chars (${realLen} real)`);
      if (realLen >= 300) {
        ap.markdown = md;
        console.log(`  ✅ patched`);
      } else {
        console.log(`  ❌ still too short, keeping old`);
      }
    } catch (e) {
      console.log(`  ❌ failed: ${e.message}`);
    }
  }

  fs.writeFileSync("reports/last-report.json", JSON.stringify(report), "utf8");
  console.log("\nSaved reports/last-report.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
