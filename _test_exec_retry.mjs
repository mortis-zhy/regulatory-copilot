/**
 * _test_exec_retry.mjs — 端到端验证执行摘要修复
 *
 * 目标：
 * 1. 摘要生成在最后（ORDER 末位是 exec）
 * 2. EXEC_LEN 显著大于 56（fallback 长度）
 * 3. 摘要章节自身有完整内容（含已核验事实/类别）
 * 4. 任何 retry 事件都被打日志（若不再触发也说明空输出率下来了）
 */
import fs from "node:fs";
import path from "node:path";
import { generateReport } from "./dist/reportGenerator.js";

const ROOT = path.resolve("..");
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "generate_payload.json"), "utf8"));
const docs = payload.documents.map((d) => ({ label: d.label, fileName: d.fileName, text: d.text }));

let regexJson = "{}";
try {
  const re = await import("./dist/regexExtractProbe.js").catch(() => null);
  if (re?.buildRegexJson) regexJson = re.buildRegexJson(docs);
} catch {}

const t0 = Date.now();
const order = [];
const retries = [];
const failed = [];
const chapters = new Map(); // id -> { title, markdown }
let execId = null;

for await (const ev of generateReport(docs, regexJson)) {
  switch (ev.type) {
    case "outline":
      console.log(`OUTLINE ${ev.outline.chapters.length} chapters`);
      // identify exec chapter id (conventionally the synthetic one with no doc refs)
      const exec = ev.outline.chapters.find((c) => /执行摘要|摘要/.test(c.title));
      execId = exec?.id;
      console.log(`EXEC_ID ${execId ?? "not-found"}`);
      break;
    case "chapter_start":
      order.push(ev.id);
      console.log(`START ${ev.id} ${ev.title}`);
      break;
    case "chapter_done":
      chapters.set(ev.id, { title: ev.title, markdown: ev.markdown ?? "" });
      const len = (ev.markdown ?? "").length;
      const failed = /本章生成失败|MiniMax request failed/.test(ev.markdown ?? "");
      console.log(`DONE ${ev.id} ${len}ch ${failed ? "FAILED" : "ok"}`);
      break;
    case "error":
      retries.push(ev.message);
      console.log(`ERR ${ev.message.slice(0, 160)}`);
      break;
  }
}

const exec = execId != null ? chapters.get(execId) : null;
const execMd = exec?.markdown ?? "";
const execLen = execMd.length;

console.log(`\n=== SUMMARY ===`);
console.log(`ORDER ${order.join(",")}`);
console.log(`RETRIES ${retries.length}`);
for (const r of retries) console.log(`  ${r.slice(0, 120)}`);
console.log(`EXEC_LEN ${execLen}`);
console.log(`EXEC_HEAD ${execMd.slice(0, 80).replace(/\n/g, "\\n")}`);
console.log(`MIN ${((Date.now() - t0) / 60000).toFixed(1)}`);
console.log(failed.length ? `FAILED_CHAPTERS ${failed.join(",")}` : `FAILED_CHAPTERS 0`);
