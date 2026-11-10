/**
 * 把 MinerU 抽出来的 **HTML 表格标记**压成可读文本。
 *
 * ## 要挡的是什么
 *
 * MinerU 抽 PDF 里的表格时，给的是 **HTML**：
 * `<table><tr><td> $v_{r}$ </td><td>激活条件</td></tr>`。
 * 而报告的表格单元是**纯文本** —— 于是那些标记**原样印在纸上**：
 *
 * ```
 * 5.26.7.5 追尾警告信号只有符合表7情况下才能开启。 <table><tr><td> vr </td><td>激活条件</td></tr> …
 * ```
 *
 * 客户在交付件第 234 页看到的就是这个（`render_gate.py` 一直在报，
 * 但**没人让它拦**——见「交付链闭合性」那节）。
 *
 * ## 压成什么
 *
 * 单元格的边界 → ` | `，行的边界 → 换行，段落标签 → 换行，
 * 其余标签丢掉 —— **但 `sub` / `sup` 留着**：
 * `N<sub>3</sub>G` 里的下标是**内容**，不是标记。
 * （渲染器另有 `restoreMineruScripts()` 把它还原成真标签。）
 *
 * ## 为什么用半角 ` | ` 而不是全角 `｜`
 *
 * 因为**回源核验**（`corroboration.ts` 的 `normalizeText`）会把半角 `|` 删掉，
 * 全角 `｜` 不会 —— 用全角会让「引文在不在那一页」这一档**判不出来**。
 * 两边的归一化结果必须**逐字相同**，否则核对会无声地掉一档。
 */

/**
 * 有语义的行内标签 —— 留着。
 *
 * **只有 `sub` / `sup`**：渲染器（`restoreMineruScripts()`）只还原这两个，
 * 别的标签留着就会**以字面量**印在纸上（`<em>` → 纸上的 `<em>`）。
 * 下标是**内容**（`N<sub>3</sub>G` = N₃G），不是标记。
 */
const KEEP_TAGS = new Set(["sub", "sup"]);

/**
 * 把 HTML 表格/段落标记压成文本。
 *
 * 只认**成形**的标签（`<name ...>` 或 `</name>`）——
 * 裸的 `<`（比较符「A < B」）不动。
 */
export function flattenHtmlMarkup(input: string): string {
  if (!input) return input ?? "";
  let t = String(input);

  // ① 单元格边界 → 分隔符；行/表边界 → 换行
  t = t.replace(/<\s*\/?\s*(?:td|th)\b[^>]*>/gi, " | ");
  t = t.replace(/<\s*\/?\s*(?:tr|tbody|thead|tfoot|table|caption|colgroup|col)\b[^>]*>/gi, "\n");

  // ② 段落级标签 → 换行（`<br>` 原本就被 `esc()` 换成换行，这里先做掉）
  t = t.replace(/<\s*\/?\s*(?:p|div|li|ul|ol|section|article|blockquote|h[1-6]|pre)\b[^>]*>/gi, "\n");

  // ③ 其余标签：有语义的留着，其余丢掉
  //
  // 这一步**必须最后做** —— 早先还有一个「把剩下的畸形标签也删掉」的兜底，
  // 它把**保留下来的 `<sub>` 也删了**（下标没了，N3G 变成 N3G 的纯文本），
  // 于是纸面上再也分不出「N3」和「N3G」。
  t = t.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, slash: string, name: string) => {
    const key = name.toLowerCase();
    if (KEEP_TAGS.has(key)) return m;
    return "";
  });

  // ④ 收拾空白：分隔符旁边不留多余空格；换行不超过两行
  t = t.replace(/[ \t]*\|[ \t]*/g, " | ");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * 切口不许切进 `$...$` —— 半截公式会**以字面量**印在纸上。
 *
 * 语料里 MinerU 把 `N₃G` 写成 `$\mathrm { N _ { 3 } G }$`。
 * 摘录窗口切在半截上，纸面上就是：
 *
 * ```
 * 对于 ${ N _ {          ← 客户看到的是这个
 * ```
 *
 * 车型类别被切碎了 —— 而「越野车（N3G）」恰恰是**限值不同**的那一类。
 *
 * @param text  整页语料
 * @param start 窗口起点
 * @param end   窗口终点（不含）
 * @returns     对齐后的 [start, end)
 */
export function alignMathWindow(text: string, start: number, end: number): [number, number] {
  const t = String(text ?? "");
  if (!t) return [start, end];
  const count = (a: number, b: number) => {
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(b, t.length); i++) if (t[i] === "$") n++;
    return n;
  };
  let s = Math.max(0, start);
  let e = Math.min(t.length, end);

  // 起点落在公式中间 → 跳过这段残公式
  if (count(0, s) % 2 === 1) {
    const close = t.indexOf("$", s);
    if (close < 0 || close >= e) return [s, s];   // 公式没闭合 → 这段丢掉
    s = close + 1;
  }
  // 终点落在公式中间 → 补到公式结束；补不到就切到公式之前
  if (count(s, e) % 2 === 1) {
    const open = t.lastIndexOf("$", e);
    const close = t.indexOf("$", e);
    if (open > s && close >= 0 && close - e <= 160) {
      e = close + 1;
    } else if (open > s) {
      e = open;
    } else {
      return [s, s];
    }
  }
  return [s, e];
}
