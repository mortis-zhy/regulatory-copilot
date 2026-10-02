/**
 * Unit test for version-relative change extraction (客户反馈: 变化点必须是 B→A).
 * Run: npx esbuild unit-test.ts --bundle --platform=node --format=cjs --outfile=dist/unit-test.cjs && node dist/unit-test.cjs
 */
import { extractJsonBlock, toFindings } from "./client/src/lib/findings";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log("✅", name);
    pass++;
  } else {
    console.log("❌", name, detail !== undefined ? JSON.stringify(detail) : "");
    fail++;
  }
}

const md = `
# 测试

| 参数 | 旧值 | 新值 | 单位 |
|---|---|---|---|
| 远光最大光强 | 430000 cd | 440000 cd | cd |
| 转向灯频率 | 4.0±1.0 Hz | 4.0±1.0 Hz | Hz |

| 维度 | A 草案 V4.3.5 | B GB 4785-2019 | C UN R48-09 |
|---|---|---|---|
| 章节数 | 10章+10附录 | 7章+9附录 | 12节+16附件 |
| 适用范围 | M、N、O类汽车 | M、N、O类汽车 | M、N类及O挂车 |
`;

const json = extractJsonBlock(md);
const f = toFindings(json);
console.log("changes:", JSON.stringify(f.changes, null, 1));
console.log("parameters:", JSON.stringify(f.parameters, null, 1));

// 1. 旧值/新值表：430000→440000 应成为 change，方向 old=旧值
const light = f.parameters.find((p) => p.name === "远光最大光强");
check("旧值/新值表 old=旧值", light?.oldValue === "430000 cd", light);
check("旧值/新值表 new=新值", light?.newValue === "440000 cd", light);
const lightChange = f.changes.find((c) => c.oldExcerpt === "430000 cd");
check("430000→440000 是 change", Boolean(lightChange));

// 2. 相同值不是 change（转向灯频率 4.0 相同）
const freqChange = f.changes.find((c) => (c.oldExcerpt ?? "").includes("4.0"));
check("相同值(4.0Hz)不产生 change", !freqChange, freqChange);
const freqParam = f.parameters.find((p) => p.name === "转向灯频率");
check("相同值仍记录为 parameter", Boolean(freqParam));

// 3. 三列文档表：old=B(现行), new=A(草案), C 进 anchor
const chapParam = f.parameters.find((p) => p.name === "章节数");
check("三列表 old=B(7章+9附录)", chapParam?.oldValue === "7章+9附录", chapParam);
check("三列表 new=A(10章+10附录)", chapParam?.newValue === "10章+10附录", chapParam);
const chapChange = f.changes.find((c) => (c.oldExcerpt ?? "").includes("7章"));
check("三列表 change 方向 B→A", Boolean(chapChange), chapChange);
check("C 值进 anchor", Boolean(chapChange && (chapChange.anchor ?? "").includes("12节")), chapChange?.anchor);

// 4. A==B（适用范围 A/B 相同）→ 无 change
const scopeChange = f.changes.find((c) => (c.oldExcerpt ?? "").includes("M、N、O类汽车") && (c.newExcerpt ?? "").includes("M、N、O类汽车"));
check("A==B 不产生 change", !scopeChange, scopeChange);
const scopeParam = f.parameters.find((p) => p.name === "适用范围");
check("A==B 仍记录 parameter", Boolean(scopeParam));

// 5. 模型 JSON 中 old==new 的伪变化被丢弃
const modelJson = JSON.parse(`{"changes":[{"id":"C1","title":"总章节数","oldExcerpt":"10章","newExcerpt":"10章"},{"id":"C2","title":"光强","oldExcerpt":"430000","newExcerpt":"440000"}]}`);
const mf = toFindings(modelJson);
check("模型JSON 丢弃 old==new", mf.changes.length === 1 && mf.changes[0].id === "C2", mf.changes);

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
