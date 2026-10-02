// dump_html.mjs - inspect the rendered HTML for missing triptych cards
import { buildHtml } from "./comparison_agent-main/dist/htmlRenderV8.js";
import fs from "fs";

const r = JSON.parse(fs.readFileSync("comparison_agent-main/reports/last-report.json", "utf8"));
const html = await buildHtml(r, []);
const idx = html.indexOf("14.x 条款 5.5");
const snippet = html.slice(Math.max(0, idx - 200), idx + 4000);
fs.writeFileSync("C:/Users/zsndz/Desktop/comparison_agent-main/ch13_5.5.html", snippet);
console.log("snippet length:", snippet.length);
const matches = snippet.match(/trip-card-missing[\s\S]*?<\/article>/g) || [];
console.log("trip-card-missing count:", matches.length);
matches.forEach((m, i) => {
  console.log(`\n--- missing card #${i+1} ---`);
  console.log(m);
});
