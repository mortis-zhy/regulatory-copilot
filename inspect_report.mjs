import fs from "fs";
const r = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
console.log("=== appendix markdown lengths ===");
for (const a of r.appendices || []) {
  console.log(" ", a.id, a.title.slice(0, 28), "→", (a.markdown || "").length, "chars",
    (a.markdown || "").replace(/[#*>\-\[\]()\s]/g, "").length < 200 ? "← SHORT" : "");
}
console.log("\n=== titles for chapters flagged missing ===");
for (const c of r.outline.chapters) {
  if (c.id === 5 || c.id === 15) console.log("  outline:", c.id, JSON.stringify(c.title));
}
console.log("\n=== all chapter titles ===");
for (const c of r.chapters) console.log("  ", c.id, c.title.slice(0, 40));
