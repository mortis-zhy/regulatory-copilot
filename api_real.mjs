/** Real test: send actual extracted PDF text through the API. */
import http from "http";
import fs from "fs";

const docs = [
  { fileName: "GB 4785 草案 V4.3.5.pdf", size: 3941 * 1024, pageCount: 103, extractedText: "" },
  { fileName: "GB 4785-2019.pdf", size: 5245 * 1024, pageCount: 81, extractedText: "" },
  { fileName: "UN_R48.pdf", size: 5245 * 1024, pageCount: 147, extractedText: "" },
];

function upload(pdfPath) {
  const fileBuffer = fs.readFileSync(pdfPath);
  const fileName = pdfPath.split("/").pop();
  const boundary = "----B" + Math.random().toString(36).slice(2);
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const fname = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}`);
  const mime = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="mimeType"\r\n\r\napplication/pdf\r\n--${boundary}--\r\n`);
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "localhost", port: 3000, path: "/api/agent/documents", method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": header.length + fileBuffer.length + fname.length + mime.length },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { const j = JSON.parse(data); resolve({ fileName, pageCount: j.serverPageCount || 0, text: j.serverExtractedText || "" }); }
        catch { resolve({ fileName, pageCount: 0, text: "" }); }
      });
    });
    req.on("error", () => resolve({ fileName, pageCount: 0, text: "" }));
    req.write(header); req.write(fileBuffer); req.write(fname); req.write(mime); req.end();
  });
}

console.log("=== 上传并提取三份 PDF ===");
for (const [i, p] of [
  "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
  "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
  "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
].entries()) {
  const d = await upload(p);
  docs[i].extractedText = d.text;
  console.log(`  ${d.fileName}: ${d.pageCount} 页, ${d.text.length} 字符`);
}

function streamChat(messages) {
  const body = JSON.stringify({ messages });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost", port: 3000, path: "/api/agent/chat/stream", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let fullText = "", buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.error) { console.log("ERROR:", j.error); }
            if (j.content) fullText += j.content;
            if (j.done) { resolve({ fullText, status: res.statusCode }); return; }
          } catch {}
        }
      });
      res.on("error", reject);
      res.on("end", () => resolve({ fullText, status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function normalize(t) { return t.replace(/\n{3,}/g, "\n\n").trim(); }
const docSummaries = docs.map((d, i) => {
  const cleaned = normalize(d.extractedText);
  return `[文档 ${i + 1}] 文件名：${d.fileName}；共 ${d.pageCount} 页\n文本（前 ${cleaned.length} 字）：\n${cleaned}`;
}).join("\n\n");

const userMsg = "请做多版本法规横向对比，输出至少 20 页 PDF。" + "\n\n【当前已上传 3 份文件】\n" + docSummaries + "\n\n请严格基于上述真实文本进行分析——多文件时按上传顺序识别为 A、B、C 等基线。";

console.log("\n=== 发送完整 prompt ===");
console.log("  prompt 长度:", userMsg.length, "字符");

const t0 = Date.now();
const { fullText } = await streamChat([{ role: "user", content: userMsg }]);
console.log("  耗时:", ((Date.now()-t0)/1000).toFixed(1), "s");
console.log("  输出长度:", fullText.length, "字符");
console.log("  含 ```json:", fullText.includes("```json"));

fs.writeFileSync("real-stream-out.txt", fullText, "utf8");
