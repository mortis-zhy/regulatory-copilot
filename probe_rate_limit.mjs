/**
 * Decisive probe: fire 4 concurrent /api/agent/report/generate requests
 * with tiny docs to trigger rate limiting, and print SSE events with timing.
 * New code → "⏳ 触发速率限制" notice + growing gaps (backoff).
 * Old code → instant per-chapter failure text, no backoff notices.
 */
import http from "http";

const tinyDoc = {
  label: "A",
  fileName: "tiny.pdf",
  text: "[第1页]\n第5章 远光灯 5.3.4.1 最大光强 430000 cd\n第6章 近光灯 5.2 明暗截止线",
};

function gen(tag) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ documents: [tinyDoc] });
    const t0 = Date.now();
    const events = [];
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path: "/api/agent/report/generate",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              const secs = ((Date.now() - t0) / 1000).toFixed(1);
              let brief = ev.type;
              if (ev.type === "chapter_start") brief += ` #${ev.id}`;
              if (ev.type === "chapter_content") brief += ` +${(ev.delta || "").length}c: ${(ev.delta || "").slice(0, 60).replace(/\n/g, " ")}`;
              if (ev.type === "chapter_done") brief += ` #${ev.id} ${ev.markdown.length}c`;
              if (ev.type === "error") brief += `: ${ev.message.slice(0, 80)}`;
              if (ev.type === "outline") brief += `: ${ev.outline.chapters.length}ch`;
              if (ev.type === "report_complete") brief += `: ${ev.chapters.length}ch`;
              console.log(`[${tag}][${secs}s] ${brief}`);
            } catch {}
          }
        });
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

console.log("=== 4 concurrent generate requests (tiny docs) ===");
await Promise.all([gen("r1"), gen("r2"), gen("r3"), gen("r4")]);
console.log("=== done ===");
process.exit(0);
