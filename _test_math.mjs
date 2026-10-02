import { buildHtml } from "./dist/htmlRenderV8.js";

const report = {
  outline: { title: "T", chapters: [{ id: 1, title: "t", sections: [] }], appendices: [] },
  chapters: [
    {
      id: 1,
      title: "测试",
      markdown: [
        "## 测试节",
        "",
        "| 版本 | 条款 | 页码 | 原文摘录 |",
        "|---|---|---|---|",
        "| **C UN R48-09** | 第 18 页 | ${\\mathrm{W}}_{12}$ | green boundary |",
        "",
        "categories $\\mathrm { O } _ { 2 } , $ and O4.",
        "",
        "double braces: $\\mathrm{{FR}}_{12}$ end",
      ].join("\n"),
    },
  ],
  sourceDocuments: [],
  generatedAt: "2026-09-30",
};

const html = await buildHtml(report, [], { withAnchors: false });
const body = html.split("chapter-body")[1]?.slice(0, 4000) ?? "";
console.log("=== BODY SNIPPET ===");
console.log(body.slice(0, 2500));
console.log("=== PROBES ===");
console.log("literal mathrm in html:", (body.match(/mathrm/g) || []).length);
console.log("sub tags:", (body.match(/<sub>/g) || []).length);
console.log("stray $ in html:", (body.match(/\$/g) || []).length);
