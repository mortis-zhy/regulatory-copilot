/** Simple API test */
import http from "http";

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

// Test 1: Simple
console.log("=== Test 1: 你好 ===");
const r1 = await streamChat([{ role: "user", content: "你好" }]);
console.log("  status:", r1.status, "length:", r1.fullText.length);
console.log("  content:", r1.fullText.slice(0, 200));

// Test 2: Simple question
console.log("\n=== Test 2: 1+1=? ===");
const r2 = await streamChat([{ role: "user", content: "1+1=?" }]);
console.log("  status:", r2.status, "length:", r2.fullText.length);
console.log("  content:", r2.fullText.slice(0, 200));

// Test 3: With system prompt
console.log("\n=== Test 3: System + 你好 ===");
const r3 = await streamChat([
  { role: "system", content: "你是 AI 助手。" },
  { role: "user", content: "你好" },
]);
console.log("  status:", r3.status, "length:", r3.fullText.length);
console.log("  content:", r3.fullText.slice(0, 200));

// Test 4: The exact prompt the frontend sends (truncated)
console.log("\n=== Test 4: Short regulatory question ===");
const r4 = await streamChat([{
  role: "system",
  content: "你是企业法规对比智能体。所有回答必须按结构对齐 → 内容对比 →专业参数 → 联网证据四层组织。",
}, {
  role: "user",
  content: "【强制要求】请对比 GB 4785 草案与 GB 4785-2019 的 3 条主要差异，每条用 markdown 列表给出。"
}]);
console.log("  status:", r4.status, "length:", r4.fullText.length);
console.log("  content:", r4.fullText.slice(0, 400));
