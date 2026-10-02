/** Test the API directly to see what the model actually returns. */
import http from "http";
import fs from "fs";

const docs = [
  { fileName: "GB 4785 草案 V4.3.5.pdf", size: 3941 * 1024, pageCount: 103, extractedText: "草案 V4.3.5 内容（占位）" + "x".repeat(86000) },
  { fileName: "GB 4785-2019.pdf", size: 5245 * 1024, pageCount: 81, extractedText: "GB 4785-2019 内容（占位）" + "y".repeat(65000) },
  { fileName: "UN_R48.pdf", size: 5245 * 1024, pageCount: 147, extractedText: "UN R48 内容（占位）" + "z".repeat(301000) },
];

function normalize(t) { return t.replace(/\n{3,}/g, "\n\n").trim(); }
const docSummaries = docs.map((d, i) => {
  const cleaned = normalize(d.extractedText);
  return `[文档 ${i + 1}] 文件名：${d.fileName}；共 ${d.pageCount} 页\n文本（前 ${cleaned.length} 字）：\n${cleaned}`;
}).join("\n\n");

const userMsg = "【核心要求——客户需求】对三份法规做多版本横向对比，必须输出至少 20 页 PDF。" + "\n\n【当前已上传 3 份文件】\n" + docSummaries + "\n\n请严格基于上述真实文本进行分析。\n\n" +
  "【强制要求——逐章节生成详细数据表格】\n\n请按以下顺序逐章生成对比内容，每章给出真实数据表格：\n\n## 章节对比模板（每章必填）\n| 章节号 | A（草案）具体内容 | B（2019 版）具体内容 | 差异 |\n|---|---|---|---|\n\n## 必须覆盖的章节\n1. 远光灯条款\n2. 近光灯条款\n3. 前雾灯条款\n4. 转向信号灯条款\n5. 倒车灯条款\n6. 位置灯条款\n7. 制动灯条款\n8. 牌照灯条款\n9. 危险警告信号\n10. 安装尺寸\n11. 试验条件\n12. 章节体系\n\n每条要包含：原文摘录（≥30 字）、具体数值（cd/Hz/mm/°/s/V 等）、章节号+页码。\n\n【重要】你的回答必须包含两个部分：\n第一部分：按结构对齐 → 内容对比 → 专业参数 → 联网证据四层组织的详细分析。内容对比必须包含至少 12 个章节对比表格。\n第二部分：JSON 代码块包含 changes（≥30）、parameters（≥25）、evidence（≥5）。\n\n**绝对禁止**：中途停止输出。每个阶段完成后必须立即进入下一阶段。";

const messages = [{ role: "user", content: userMsg }];

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
            if (j.error) { reject(new Error(j.error)); return; }
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

const t0 = Date.now();
const { fullText, status } = await streamChat(messages);
const ms = Date.now() - t0;

console.log("HTTP status:", status);
console.log("耗时:", (ms/1000).toFixed(1), "s");
console.log("累积 content 长度:", fullText.length, "字符");
console.log("换行数:", fullText.split("\n").length);
console.log("含 ```json:", fullText.includes("```json"));

const fence = fullText.match(/```json\s*([\s\S]*?)```/);
if (fence) {
  try {
    const parsed = JSON.parse(fence[1]);
    console.log("\nJSON:");
    console.log("  changes:", parsed.changes?.length || 0);
    console.log("  parameters:", parsed.parameters?.length || 0);
    console.log("  evidence:", parsed.evidence?.length || 0);
  } catch (e) { console.log("JSON parse error:", e.message); }
}

fs.writeFileSync("api-stream-out.txt", fullText, "utf8");
console.log("\n已保存到 api-stream-out.txt");
