/**
 * 项目宣讲稿生成器 —— 讲稿式 PDF（内部领导 / 立项汇报用）。
 *
 * 设计约束：
 *   * 16:9 横版（13.333in × 7.5in），可直接投屏，也可导入 PPT。
 *   * 每页底部一条「讲解提示」带 —— 照着念就不会跑题。
 *   * **所有图表都是渲染出来的 PNG**，不是文字表格：
 *       - 真实产品截图（交付 PDF 的实际页面 + 网站实际界面）→ 直接截图
 *       - 架构 / 闸门 / 流程图 → 用同一个 Chromium 渲染成 PNG 再嵌入
 *     这样打印出来和投影出来是同一张图，不会因为浏览器缺字体变形。
 *
 * 用法：node scripts/render_briefing.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, "..", "宣讲件");
const ASSETS = path.join(OUT, "assets");
const FIGDIR = path.join(OUT, "figures");

fs.mkdirSync(FIGDIR, { recursive: true });

// ── 配色（沿用报告的视觉语言） ─────────────────────────────────────────────
const C = {
  ink: "#0c1a2b",
  ink2: "#243447",
  gold: "#a17334",
  gold2: "#c08f45",
  paper: "#faf6ec",
  card: "#ffffff",
  line: "#e6dfd0",
  mute: "#7c6a4f",
  ok: "#1f7a4d",
  warn: "#b4552d",
  chip: "#f1e9d8",
};

/**
 * 闸门数量 —— **从机器产物读，不在稿子里手写**。
 *
 * 手写的数字一定会过期：本项目加了一道新闸门（参数查询对空格不敏感）之后，
 * 稿子还写着旧的「97 项」，交付件里报的数字与当场跑出来的 98 对不上。
 * 宁可空着，不可错着 —— 所以这里读不到就**拒绝出稿**，不拿一个猜的数糊过去。
 */
const GATES = (() => {
  const p = path.join(ROOT, "dist", "verify-summary.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      `读不到 ${p} —— 闸门数量必须来自机器。先跑一次 \`npm run verify\`，再出讲稿。`,
    );
  }
  const s = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!s.total || s.failed) {
    throw new Error(`verify-summary.json 内容异常（total=${s.total} failed=${s.failed}）—— 先把闸门跑绿。`);
  }
  return String(s.total);
})();

/**
 * 用**系统字体**，不内嵌 base64。
 *
 * 内嵌四套中文字体（msyh.ttc 19MB + msyhbd 16MB + simsun 17MB + simsunb 21MB）
 * 展开成 base64 是 **97 MB 的 HTML** —— Chromium 会在 setContent 阶段直接
 * 把浏览器进程撑爆（Target page, context or browser has been closed）。
 * 报告渲染器 htmlRenderV8 也内嵌，因为它要能在一台没装中文字体的服务器上跑；
 * 而宣讲稿只在本机生成，系统字体一定在。
 *
 * Windows 上 msyh.ttc 的家族名是 "Microsoft YaHei"，simsun.ttc 是 "SimSun"。
 */
const SYSTEM_FONT_CSS = `
@font-face{font-family:"DECKYH";font-weight:400;font-style:normal;src:local("Microsoft YaHei");}
@font-face{font-family:"DECKYH";font-weight:700;font-style:normal;src:local("Microsoft YaHei Bold");}
@font-face{font-family:"DECKSS";font-weight:400;font-style:normal;src:local("SimSun");}
@font-face{font-family:"DECKSS";font-weight:700;font-style:normal;src:local("SimSun Bold");}
`;

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"DECKYH","Microsoft YaHei",sans-serif;color:${C.ink};-webkit-font-smoothing:antialiased}
.hd{font-family:"DECKSS","SimSun",serif}
.tnum{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
`;

// ── 图表（每张渲染成 PNG） ────────────────────────────────────────────────
const FIG = {
  // 架构分层
  arch: `
  <div class="fig">
    <div class="lane"><span class="lname">输入</span>
      <div class="box src">A 草案 V4.3.5<br>B GB 4785-2019<br>C UN R48-09</div>
    </div>
    <div class="arrow">↓</div>
    <div class="lane"><span class="lname">语料层</span>
      <div class="box">MinerU 4.0.6 + PyMuPDF 兜底<br><span class="dim">extract-cache · facts.json</span></div>
      <div class="box">条款索引<br><span class="dim">clause-index.json</span></div>
    </div>
    <div class="arrow">↓</div>
    <div class="lane"><span class="lname">参数层</span>
      <div class="box hi">319 参数 × 3 版 · 957 取值位<br><span class="dim">每条带 patterns + why + absent</span></div>
    </div>
    <div class="arrow">↓</div>
    <div class="lane"><span class="lname">判定层</span>
      <div class="box">差值裁定<br><span class="dim">changeLedger</span></div>
      <div class="box">闭环台账<br><span class="dim">closureLedger · 57 条</span></div>
      <div class="box">要求台账<br><span class="dim">448 条 · 真缺口 0</span></div>
      <div class="box">定性并排<br><span class="dim">附录 H · 326 可比</span></div>
    </div>
    <div class="arrow">↓</div>
    <div class="lane"><span class="lname">呈现层</span>
      <div class="box">reportV6 · 14 章 + 8 附录</div>
      <div class="box hi">htmlRenderV8 → 249 页 PDF</div>
    </div>
    <div class="note">模型<b>不</b>出现在这条链上 —— 凡是会印进客户手里的数字，都走确定性抽取 + 机器回源复核。</div>
  </div>`,

  // agentic loop
  loop: `
  <div class="fig">
    <div class="row">
      <div class="step">用户提问<br><span class="dim">"草案相比现行版新增了哪些章节"</span></div>
      <div class="arrow r">→</div>
      <div class="step hi">模型输出 tool_call<br><span class="dim">toolChoice: auto · temp 0.2</span></div>
      <div class="arrow r">→</div>
      <div class="step">派发到 7 个取证工具<br><span class="dim">全部回源到三份 PDF</span></div>
    </div>
    <div class="row2">
      <div class="step">工具结果以 role:"tool" 塞回对话 → 继续下一轮</div>
      <div class="arrow r">↺</div>
      <div class="step warn">收口判定<br><span class="dim">连续 2 轮整轮都没查着 → 强制据实收口</span></div>
    </div>
    <div class="toolbar">
      <span class="tool">lookup_clause</span><span class="tool">find_quote</span>
      <span class="tool">lookup_parameter</span><span class="tool">get_diff_verdict</span>
      <span class="tool">get_coverage_status</span><span class="tool">list_requirement_gaps</span>
      <span class="tool">get_topic_excerpts</span>
    </div>
    <div class="note">最多 12 轮。<b>工具查不到就是查不到</b> —— 不许模型换措辞继续碰运气（宁可空着，不可错着）。</div>
  </div>`,

  // 三明治
  sandwich: `
  <div class="fig">
    <div class="sand">
      <div class="lay l1"><b>① 确定性候选层</b><span class="dim">candidateSentences / unitRegex / deviceChapterPrefixes —— 不调模型，直接从源文捞候选句并按装置归类</span></div>
      <div class="lay l2"><b>② 模型选择层</b><span class="dim">MiniMax 在候选池里挑出最像的那条</span></div>
      <div class="lay l3"><b>③ 确定性校验层</b><span class="dim">validateProposal —— 必须命中 / 捕获组必须框出数字 / 命中位置必须落在所选章节区间内。过不了的直接拒收</span></div>
      <div class="lay l4"><b>④ 人工确认层</b><span class="dim">/proposals 页面逐条确认，才写进 data/parameter-specs.json</span></div>
    </div>
    <div class="note">模型只在第 ② 层。候选从哪来、答案合不合格，全是代码说了算 —— 换模型、换标准都不影响可靠性。</div>
  </div>`,

  // 三层保障
  layers: `
  <div class="fig">
    <table class="tbl">
      <tr><th style="width:15%">层</th><th style="width:36%">机制</th><th>挡住过的真错</th></tr>
      <tr><td><b>数据层</b></td><td>每个取值带条款号 + 页码 + <code>why</code>；抽取路径必须落回<b>源 PDF 的那一页</b></td>
        <td>① 「宽度大于2.\\n10m」被当碎片删掉 → <b class="bad">2.10m 变成 10m</b>（差一个数量级）<br>② A 草案 5.20 是无编号小节，条款索引整段吞掉 4 个装置 <b class="bad">71 条</b></td></tr>
      <tr><td><b>判定层</b></td><td>差值裁定逐条回原文；勘误表；要求台账 448 条六档归类</td>
        <td>① 「转向信号灯首次熄灭时间」被标成"假差异·勿提变更单"，而它正是第一条真变化 chg01<br>② §11.4 的 9 条<b>已裁定</b>项被算进"待复核"桶 → 首页 10 条 vs §11.0 的 0 条，同一份报告自相矛盾</td></tr>
      <tr><td><b>呈现层</b></td><td>章节与台账同源对账；空表不许印成"未检索到"</td>
        <td>① 第 3 页断言"14 项实质变化" vs 第 20 页的 17 条打架<br>② "测量基准"整段说明印了 33 次<br>③ 第 10 章空表印成"未检索到对应标题"</td></tr>
    </table>
  </div>`,

  // 闸门六段
  gates: `
  <div class="fig">
    <div class="gates">
      <div class="g"><span class="n">1</span><b>dist modules present</b><span class="d">构建产物齐全</span></div>
      <div class="g"><span class="n">2</span><b>dist is current with source</b><span class="d">源码改了没重建 → 红（防"修了 dist/*.js"那个老坑）</span></div>
      <div class="g"><span class="n">3</span><b>source invariants</b><span class="d">只 grep 源码，永不 grep dist/</span></div>
      <div class="g"><span class="n">3b</span><b>agent 取证循环不变量</b><span class="d">工具回源对不对</span></div>
      <div class="g"><span class="n">4</span><b>python verification layer</b><span class="d">取值回源核验</span></div>
      <div class="g"><span class="n">4b</span><b>rendered report</b><span class="d">渲染出来的那份报告本身自检</span></div>
    </div>
    <div class="gates">
      <div class="g wide"><span class="n">5</span><b>renderer unit harness</b><span class="d">11 个 _test_*.mjs —— 名字像测试文件，其实是闸门：删掉 verify 当场红</span></div>
    </div>
    <div class="note">每一道闸门背后都是<b>一次真实翻车</b>。这比"我们保证"有说服力 —— 因为闸门可以当场验。</div>
  </div>`,

  // 覆盖度数字板
  metrics: `
  <div class="fig">
    <div class="mgrid">
      <div class="m"><span class="v">100<span class="u">%</span></span><span class="l">三版条款覆盖</span><span class="d">A 124 条款 / B 105 / C 142<br>missing 0 · 别装置顶替 0</span></div>
      <div class="m"><span class="v">0</span><span class="l">真缺口</span><span class="d">448 条要求里<br>285 已覆盖 · 66 附录逐条列出<br>52 已引原文 · 45 非产品要求</span></div>
      <div class="m"><span class="v">969</span><span class="l">定量限值被覆盖</span><span class="d">A 340 · B 287 · C 342</span></div>
      <div class="m"><span class="v">787<span class="u">/957</span></span><span class="l">参数取值位有值</span><span class="d">319 参数 × 3 版<br>其余 170 格是<b>有理由的空</b>（该版确实没规定）</span></div>
      <div class="m"><span class="v">184</span><span class="l">定性条款逐条并排</span><span class="d">附录 H · 另 142 条同文<br>86 条编号不可对读 → 只登记不并排</span></div>
      <div class="m"><span class="v">517<span class="u">/517</span></span><span class="l">引文回源命中</span><span class="d">附录 H 每条引文<br>逐条回源 PDF 验过</span></div>
    </div>
  </div>`,

  // 三条抱怨兑现
  complaints: `
  <div class="fig">
    <table class="tbl cmp">
      <tr><th style="width:27%">客户原话</th><th style="width:38%">现在的答案</th><th>可当场验的判据</th></tr>
      <tr><td class="q">"仍然只有法规中，有具体数值的内容的比较"</td>
        <td>附录 H：<b>定性条款也逐条并排</b>，差异处粗体标出</td>
        <td>附录 H.2 = 184 条并排；<code>check_qualitative_diff.py</code> 517/517 回源命中</td></tr>
      <tr><td class="q">"数值有提取错误或空缺"</td>
        <td>① 修掉完整性保证本身的洞（条款索引吞掉 71 条）<br>② 空缺必须是<b>有理由的空</b>，与"抽取失败"措辞不同</td>
        <td>三版 missing 0 / 别装置顶替 0；<code>clause_value_check</code> · <code>matrix_page_check</code> · <code>diff_value_check</code> 三道回源</td></tr>
      <tr><td class="q">"仅有两版国标，无欧标，只有罗列，无对比"</td>
        <td>① 第 14 章欧标第三列（条款号+页码+原文）<br>② §11.0 一份权威变化清单，报告各处只报这一个数<br>③ 第 12 章改决策视图，不再是三列罗列</td>
        <td>26 条章节级对应逐条回原文验过；§11.0 与首页仪表盘<b>同源对账</b>（新闸门盯着）</td></tr>
    </table>
  </div>`,

  // 投入产出
  roi: `
  <div class="fig">
    <table class="tbl">
      <tr><th style="width:26%">过去要人工做的事</th><th style="width:34%">现在</th><th>量级</th></tr>
      <tr><td>把三份 PDF 的条款逐条读出来建索引</td><td>脚本切条款，机器回源</td><td>A 124 + B 105 + C 142 = 371 条</td></tr>
      <tr><td>把每个参数在三个版本里的值抄进表里</td><td>spec 驱动 + 机器校验</td><td>957 个取值位</td></tr>
      <tr><td>判断"哪些差异是真变化"</td><td>差值裁定 + 勘误表逐条回原文</td><td>57 条闭环条目 → 17 条真实变化</td></tr>
      <tr><td>把定性条款挑出来给客户看</td><td>装置感知的 A/B 自动配对</td><td>326 条可比 + 86 条只登记</td></tr>
      <tr><td>逐条核对自己印出来的数字有没有错</td><td>${GATES} 项闸门，改坏就红</td><td>每一条结论都带页码</td></tr>
    </table>
    <div class="note">人工没被替代 —— 人工被挪到了<b>该由人判断的地方</b>（方向相反的条件句、工程影响、编号重排）。</div>
  </div>`,

  // 现状与缺口
  gaps: `
  <div class="fig">
    <div class="gcols">
      <div class="gcol">
        <h4>还没做的（说清楚比藏着好）</h4>
        <ul>
          <li><b>/projects、/documents 是占位页</b>（"该功能即将上线"），不是坏了，是没做</li>
          <li><b>Word 导出只导最近一条问答</b>，不是整份报告；PDF 按钮才是 249 页全文</li>
          <li><b>欧标只到章节级 + 参数级</b>，条款级刻意不做 —— R48 与 GB 编号体系不同构，逐号对读会造假对应</li>
          <li><b>差值方向相反的条件句</b>（如"低于 65 不得开启" vs "开启上限 65"）无法从数值矩阵自动检出，要人工过一遍</li>
          <li>参数取值位 957 里 787 有值，其余 170 格是"该版确实没规定"，<b>不是</b>抽取失败 —— 但也确实没填</li>
        </ul>
      </div>
      <div class="gcol">
        <h4>这套东西现在有多值钱</h4>
        <ul>
          <li>换标准：<b>另建一套 spec 包</b>即可复用全部机制（现 spec 只对这三版有效，换了会响亮地失败而不是静默出错）</li>
          <li>加装置 / 加参数：走同一条流水线，人工只做"确认"不做"抄"</li>
          <li>每一条结论可回源到 PDF 的某一页 —— <b>这是可以拿去跟认证方对话的</b></li>
          <li>网页端可让客户自己提问取证（agentic loop），不必每次都找我们</li>
        </ul>
      </div>
    </div>
  </div>`,

  // 下一步
  next: `
  <div class="fig">
    <div class="ngrid">
      <div class="ncard">
        <span class="tag">方向一</span>
        <h4>定性条款并排从 A/B 扩到 A/B/C</h4>
        <p>现在附录 H 是 A|B 两栏。C 侧只能章节级，因为 R48 与 GB 编号不同构。</p>
        <p class="dim">可做：以「装置 + 款」为键做三方语义配对（不是编号对读），并排出三栏。价值：出口欧盟时直接看三版定性差异。</p>
        <p class="cost">成本：装置语义映射表要人工建立一次（约 30 装置 × 7 款）</p>
      </div>
      <div class="ncard">
        <span class="tag">方向二</span>
        <h4>条件方向检查器</h4>
        <p>现在数值矩阵只看数，看不出"同样的两个数、条件方向相反"。已发现 1 例（驾驶辅助投射车速）。</p>
        <p class="dim">可做：从原句抽取「不得/应/不超过/不低于/低于才」这类限定词，与数值绑定，做方向一致性检查。</p>
        <p class="cost">成本：中等。要把限定词抽准，且必须回源复核，不能只靠正则</p>
      </div>
      <div class="ncard">
        <span class="tag">方向三</span>
        <h4>把 170 个「有理由的空」补上</h4>
        <p>957 个取值位里 787 有值。剩下的分三类：该版没规定 / 抽不到 / 还没挖。</p>
        <p class="dim">可做：用取值规格提议 agent 跑一轮候选，人工确认后补齐 —— 流程已跑通（/proposals 现存 48 行待裁定）。</p>
        <p class="cost">成本：低。已有 agent + 校验层 + 人工确认页，只差产能</p>
      </div>
    </div>
  </div>`,

  // 命令速查
  cmds: `
  <div class="fig">
    <table class="tbl cmd">
      <tr><th style="width:34%">命令</th><th>干什么</th></tr>
      <tr><td><code>npm run verify</code></td><td><b>交付闸门</b> —— ${GATES} 项检查。改完必跑，绿了才准交付</td></tr>
      <tr><td><code>npm run build</code></td><td>构建（vite + 15 个可加载模块）</td></tr>
      <tr><td><code>node rebuild_report.mjs</code></td><td>重建 <code>reports/last-report.json</code>（14 章 + 8 附录）</td></tr>
      <tr><td><code>node render_to_pdfdir.mjs</code></td><td>出交付 PDF → <code>PDF对比/</code></td></tr>
      <tr><td><code>NODE_ENV=production node dist/index.js</code></td><td>起服务（<code>npm start</code> 在 Windows 上会失败）</td></tr>
      <tr><td><code>npm run dev</code></td><td>开发模式，改前端自动热更</td></tr>
    </table>
  </div>`,
};

// ── 图表样式 ──────────────────────────────────────────────────────────────
const FIG_CSS = `
body{width:1188px;padding:22px 24px;background:#fff;color:${C.ink}}
.fig{font-size:17px;line-height:1.55}
.dim{color:${C.mute};font-size:.86em}
.note{margin-top:14px;padding:11px 14px;background:${C.chip};border-left:4px solid ${C.gold};
      border-radius:0 6px 6px 0;font-size:15px;color:${C.ink2}}
.lane{display:flex;gap:14px;align-items:stretch;margin-bottom:2px}
.lname{flex:0 0 74px;text-align:right;padding-top:12px;color:${C.mute};font-size:14px;font-weight:700;
       border-right:2px solid ${C.line};padding-right:12px}
.box{flex:1;background:${C.card};border:1px solid ${C.line};border-radius:8px;padding:12px 14px;
     font-weight:700;text-align:center;box-shadow:0 1px 3px rgba(12,26,43,.05)}
.box.hi{background:#eef6f1;border-color:#bcdccc}
.box.src{background:#fdf6ec;border-color:#e8d5b4}
.arrow{text-align:center;color:${C.gold};font-size:20px;line-height:1.2;margin:4px 0 4px 74px}
.row{display:flex;gap:12px;align-items:stretch}
.row2{display:flex;gap:12px;align-items:stretch;margin-top:12px}
.step{flex:1;background:${C.card};border:1px solid ${C.line};border-radius:8px;padding:13px 14px;
      font-weight:700;text-align:center}
.step.hi{background:#eef6f1;border-color:#bcdccc}
.step.warn{background:#fdf0e9;border-color:#eccfc0}
.arrow.r{flex:0 0 26px;display:flex;align-items:center;justify-content:center;color:${C.gold};font-size:22px}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.tool{background:${C.ink};color:#fff;border-radius:14px;padding:5px 12px;font-size:13px;
      font-family:Consolas,monospace}
.lay{border-radius:8px;padding:11px 14px;margin-bottom:8px;display:flex;gap:14px;align-items:baseline}
.lay b{flex:0 0 168px}
.lay .dim{flex:1}
.l1{background:#eef2f7;border-left:5px solid #5b7391}
.l2{background:#fdf6ec;border-left:5px solid ${C.gold}}
.l3{background:#eef6f1;border-left:5px solid ${C.ok}}
.l4{background:#f4eef7;border-left:5px solid #7a5ea8}
.tbl{width:100%;border-collapse:collapse;font-size:16px}
.tbl th{background:${C.ink};color:#fff;text-align:left;padding:11px 12px;font-weight:700}
.tbl td{border:1px solid ${C.line};padding:11px 12px;vertical-align:top}
.tbl tr:nth-child(even) td{background:#fcfaf5}
.tbl code{background:#eef2f7;padding:1px 5px;border-radius:3px;font-family:Consolas,monospace;font-size:.92em}
.bad{color:${C.warn}}
.q{color:${C.warn};font-style:italic}
.gates{display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.g{flex:1;min-width:190px;background:#fcfaf5;border:1px solid ${C.line};border-radius:8px;padding:12px 13px}
.g.wide{flex:1 1 100%}
.g .n{display:inline-block;background:${C.gold};color:#fff;border-radius:5px;padding:1px 8px;
       font-size:13px;font-weight:700;margin-bottom:6px}
.g b{display:block;font-size:15.5px}
.g .d{display:block;color:${C.mute};font-size:13.5px;margin-top:3px;line-height:1.45}
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.m{border:1px solid ${C.line};border-radius:10px;padding:16px 16px 14px;background:#fcfaf5}
.m .v{display:block;font-size:42px;font-weight:700;color:${C.gold};line-height:1.05;
      font-variant-numeric:tabular-nums}
.m .v .u{font-size:22px;color:${C.ink2}}
.m .l{display:block;font-weight:700;font-size:16.5px;margin:6px 0 6px}
.m .d{display:block;color:${C.mute};font-size:13.5px;line-height:1.5}
.gcols{display:grid;grid-template-columns:1fr 1fr;gap:26px}
.gcol h4{font-size:19px;color:${C.ink};margin-bottom:10px;padding-bottom:7px;border-bottom:2px solid ${C.gold}}
.gcol ul{list-style:none}
.gcol li{position:relative;padding-left:19px;margin-bottom:9px;font-size:15.5px;line-height:1.55}
.gcol li:before{content:"▸";position:absolute;left:0;color:${C.gold};font-weight:700}
.ngrid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.ncard{border:1px solid ${C.line};border-radius:10px;padding:16px;background:#fcfaf5}
.ncard .tag{display:inline-block;background:${C.ink};color:#fff;border-radius:4px;padding:2px 9px;font-size:13px;font-weight:700}
.ncard h4{font-size:18px;margin:9px 0 9px;line-height:1.35}
.ncard p{font-size:14.5px;margin-bottom:8px;line-height:1.5}
.ncard .cost{font-size:13px;color:${C.warn};border-top:1px dashed ${C.line};padding-top:8px}
.tbl.cmd td:first-child{white-space:nowrap}
.tbl.cmd code{font-size:13.5px}
`;

// ── 讲稿页 ────────────────────────────────────────────────────────────────
const S = (n, title, kicker) => ({ n, title, kicker });
const notes = []; // 由 page() 收集

/**
 * 一页一个视觉主体 —— 16:9 投屏时，图小了就读不了。
 *   layout "text"    正文（可选右侧小图）
 *   layout "fig"     一行导语 + 大图占满剩余空间
 *   layout "figshot" 左大图 + 右实物截图
 *   layout "shot"    左正文 + 右实物截图
 */
function page({ sec, num, title, sub, body, lead, endline, note, shot, shotCaption, fig, figNote, layout }) {
  const L = layout ?? (fig ? (shot ? "figshot" : "fig") : shot ? "shot" : "text");
  const cls = L === "fig" ? "pbody stack" : `pbody ${L}`;
  const leadHtml = lead ? `<div class="plead">${lead}</div>` : "";
  let inner;
  if (L === "fig") {
    inner = `${leadHtml}<div class="pfig"><img src="data:image/png;base64,${fig}"/>${
      figNote ? `<div class="cap">${figNote}</div>` : ""
    }</div>`;
  } else if (L === "figshot") {
    inner = `<div class="pfig"><img src="data:image/png;base64,${fig}"/></div>
      <div class="pshot"><img src="data:image/png;base64,${shot}"/><div class="cap">${shotCaption ?? ""}</div></div>`;
  } else if (L === "shot") {
    inner = `<div class="ptext">${body}</div>
      <div class="pshot"><img src="data:image/png;base64,${shot}"/><div class="cap">${shotCaption ?? ""}</div></div>`;
  } else {
    // 结论条必须**在正文列里**，否则会被 flex 当成并排的第二个元素
    inner = `<div class="ptext">${body}${endline ? `<div class="endline">${endline}</div>` : ""}</div>`;
  }
  return `
  <section class="page">
    <div class="phead">
      <div class="ptitle hd">${title}</div>
      ${sub ? `<div class="psub">${sub}</div>` : ""}
      <div class="pmeta"><span class="psec">${sec}</span><span class="pnum">${num}</span></div>
    </div>
    <div class="${cls}">
      ${inner}
    </div>
    <div class="note-band">
      <span class="nb-tag">讲解提示</span>
      <div class="nb-text">${note}</div>
    </div>
  </section>`;
}

const DECK_CSS = `
@page{size:13.333in 7.5in;margin:0}
html,body{margin:0;padding:0;background:#fff}
.page{width:13.333in;height:7.5in;position:relative;overflow:hidden;page-break-after:always;
      background:${C.paper};display:flex;flex-direction:column}
.page:last-child{page-break-after:auto}
.phead{position:relative;padding:26px 46px 12px;border-bottom:2px solid ${C.ink}}
.ptitle{font-size:30px;font-weight:700;color:${C.ink};letter-spacing:.5px;padding-right:150px}
.psub{font-size:15px;color:${C.mute};margin-top:5px;padding-right:150px}
.pmeta{position:absolute;right:46px;top:28px;text-align:right}
.psec{display:block;font-size:12px;letter-spacing:2px;color:${C.gold};font-weight:700}
.pnum{display:block;font-size:26px;font-weight:700;color:${C.line};line-height:1.1}
.pbody{flex:1;padding:18px 46px 6px;display:flex;gap:26px;align-items:flex-start;min-height:0;overflow:hidden}
.pbody.stack{flex-direction:column;gap:10px;align-items:stretch}
.ptext{flex:1;min-width:0}
.plead{flex:0 0 auto;font-size:15px;color:#7c6a4f;line-height:1.5}
.pbody.stack .pfig{flex:1;min-height:0;display:flex;justify-content:center;align-items:center}
.ptext h3{font-size:19px;margin:0 0 9px;color:${C.ink}}
.ptext p{font-size:16px;line-height:1.62;margin-bottom:10px;color:${C.ink2}}
.ptext ul{list-style:none}
.ptext li{position:relative;padding-left:20px;margin-bottom:9px;font-size:16px;line-height:1.58;color:${C.ink2}}
.ptext li:before{content:"▸";position:absolute;left:0;color:${C.gold};font-weight:700}
.ptext code{background:#eef2f7;padding:1px 6px;border-radius:3px;font-family:Consolas,monospace;font-size:.9em;color:${C.ink}}
.ptext b{color:${C.ink}}
.pfig{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-start;min-height:0}
.pfig img{width:100%;height:auto;max-height:100%;object-fit:contain;display:block;border-radius:8px}
.pbody.figshot .pfig{flex:1 1 auto}
.pbody.figshot .pshot{flex:0 0 300px}
.pshot{flex:0 0 430px;text-align:center;align-self:center}
.pshot img{max-height:430px;object-fit:contain}
.pshot img{width:100%;border:1px solid ${C.line};border-radius:6px;box-shadow:0 6px 20px rgba(12,26,43,.14);
           display:block;background:#fff}
.cap{font-size:12.5px;color:${C.mute};margin-top:7px;line-height:1.45}
.note-band{flex:0 0 auto;margin:0 46px 18px;background:#f3ecdc;border-left:5px solid ${C.gold};
           border-radius:0 7px 7px 0;padding:10px 15px;display:flex;gap:14px;align-items:flex-start}
.nb-tag{flex:0 0 auto;font-size:12px;font-weight:700;color:#fff;background:${C.gold};
        border-radius:4px;padding:2px 9px;letter-spacing:1px;margin-top:1px}
.nb-text{font-size:14.5px;line-height:1.55;color:${C.ink2}}
.ptext table{width:100%;border-collapse:collapse;font-size:15px;margin-top:4px}
.ptext th{background:${C.ink};color:#fff;text-align:left;padding:9px 11px;font-weight:700}
.ptext td{border:1px solid ${C.line};padding:9px 11px;vertical-align:top;line-height:1.5}
.ptext tr:nth-child(even) td{background:#fcfaf5}
.cover{background:linear-gradient(160deg,#0c1a2b 0%,#16283f 62%,#1d3450 100%);color:#fff;
       padding:64px 74px;display:flex;flex-direction:column;justify-content:center}
.cover .eyebrow{font-size:13px;letter-spacing:5px;color:${C.gold2};font-weight:700;margin-bottom:20px}
.cover h1{font-family:"DECKSS","SimSun",serif;font-size:50px;line-height:1.24;margin-bottom:16px;font-weight:700}
.cover .sub{font-size:19px;color:#b9c6d6;line-height:1.6;margin-bottom:36px}
.cover .cards{display:flex;gap:16px;margin-bottom:34px}
.cover .card{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);
             border-radius:10px;padding:18px 20px}
.cover .card .v{font-size:38px;font-weight:700;color:${C.gold2};line-height:1.1}
.cover .card .l{font-size:14px;color:#b9c6d6;margin-top:5px}
.cover .foot{font-size:13.5px;color:#8496ab;line-height:1.7}
.cover .note-band{background:rgba(255,255,255,.07);border-left-color:${C.gold2};margin:0}
.cover .nb-text{color:#cfd9e5}
.kpi{display:flex;gap:14px;margin:12px 0 4px}
.kpi .k{flex:1;background:#fff;border:1px solid ${C.line};border-radius:9px;padding:13px 15px}
.kpi .k .v{font-size:31px;font-weight:700;color:${C.gold};line-height:1.1;font-variant-numeric:tabular-nums}
.kpi .k .l{font-size:13.5px;color:${C.mute};margin-top:4px}
.qbox{background:#fdf3ec;border-left:5px solid ${C.warn};padding:15px 19px;border-radius:0 7px 7px 0;
      margin-bottom:12px;font-size:18px;color:${C.ink2};font-style:italic;line-height:1.5}
.abox{background:#eef6f1;border-left:5px solid ${C.ok};padding:15px 19px;border-radius:0 7px 7px 0;
      margin-bottom:20px;font-size:17.5px;color:${C.ink2};line-height:1.62}
.abox b{color:${C.ok}}
.endline{flex:0 0 auto;margin-top:14px;background:${C.ink};color:#fff;border-radius:8px;
         padding:13px 18px;font-size:16.5px;line-height:1.5}
.endline b{color:${C.gold2}}
.pbody.shot .pshot{flex:0 0 560px}
.pshot img{max-height:100%}
`;

function img(name) {
  const p = path.join(ASSETS, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p).toString("base64");
}

// ── 组装 ──────────────────────────────────────────────────────────────────
function buildDeck(figData) {
  // F 返回**裸 base64** —— page() 会自己包 <img>。
  // （早先这里返回完整 <img> 标签，被 page() 又包了一层，
  //   于是 HTML 变成 <img src="data:...,<img src=...>" /> —— 图标直接裂掉。）
  const F = (k) => figData[k];
  const shot = (n) => {
    const b = img(n);
    return b ? `<img src="data:image/png;base64,${b}"/>` : "";
  };
  const S1 = (n) => {
    const b = img(n);
    return b ? b : null;
  };

  const pages = [];

  // 1 封面
  pages.push(`
  <section class="page cover">
    <div class="eyebrow">REGULATORY COMPARISON · 立项汇报</div>
    <h1>GB 4785 三版法规横向对比<br/>从「罗列」到「可核验的决策依据」</h1>
    <div class="sub">A 草案 V4.3.5　·　B 现行 GB 4785-2019　·　C UN R48-09<br/>
      交付件 249 页 · 14 章 + 8 附录 · 每一条结论带条款号与页码</div>
    <div class="cards">
      <div class="card"><div class="v">319</div><div class="l">参数 × 3 版 = 957 个取值位</div></div>
      <div class="card"><div class="v">${GATES}</div><div class="l">项交付闸门（改坏就红）</div></div>
      <div class="card"><div class="v">0</div><div class="l">真缺口 · 别装置顶替</div></div>
      <div class="card"><div class="v">517/517</div><div class="l">定性引文回源命中</div></div>
    </div>
    <div class="foot">
      2026-10-28　·　汇报人：＿＿＿＿＿<br/>
      本稿为讲稿式：每页底部有「讲解提示」，照着念即可，不会跑题
    </div>
  </section>`);

  // 2 一页结论
  pages.push(page({
    sec: "结论", num: "02", title: "先给结论：这个系统现在能干什么",
    sub: "三条抱怨逐条兑现，机器可验",
    body: `
      <div class="kpi">
        <div class="k"><div class="v">100%</div><div class="l">三版条款覆盖 · missing 0 · 别装置顶替 0</div></div>
        <div class="k"><div class="v">0</div><div class="l">448 条要求里的真缺口</div></div>
        <div class="k"><div class="v">17</div><div class="l">§11.0 真实变化（全报告只报这一个数）</div></div>
      </div>
      <h3 style="margin-top:16px">四条能当场验的能力</h3>
      <ul>
        <li><b>数值对比</b>：319 个参数 × 3 版，每个取值带条款号、页码、原文摘录</li>
        <li><b>定性并排</b>：附录 H 把 184 条<b>无数值</b>的条款也逐条并排，差异处粗体标出</li>
        <li><b>欧标第三列</b>：UN R48-09 的条款号 + 页码 + 原文，26 条章节级对应逐条回源验过</li>
        <li><b>可追责</b>：${GATES} 项闸门在交付前跑一遍；每条结论都能翻到源 PDF 的某一页</li>
      </ul>`,
    endline: `这四条合起来才是「能交给客户」—— <b>不是一份更厚的报告，是一条会自己证明自己没取错数的产线</b>。`,
    note: `开场先说这四条，不展开。领导如果只关心一件事，多半是「凭什么信」—— 直接跳到第 10 页（闸门）比讲功能有用。`,
  }));

  // 3 客户抱怨
  pages.push(page({
    sec: "问题", num: "03", title: "客户原来抱怨的三条 —— 现在各自的答案",
    sub: "引号里是客户原话（原文见 PDF对比/feedback.md）",
    body: `
      <div class="qbox">① 「这一版和之前的差别不大，仍然只有法规中，有具体数值的内容的比较，例如安装高度，响应时间，光强等。」</div>
      <div class="abox">→ <b>差别就在新增的三块</b>：附录 H 把<b>无数值</b>的定性条款也逐条并排（184 条）；第 14 章补上真正的<b>欧标第三列</b>（26 条章节级对应）；§11.0 一份权威变化清单（17 条真实变化）。参数也从 305 补到 319。</div>
      <div class="qbox">② 「前段是数值摘取进行罗列对比。数值有提取错误或空缺。」</div>
      <div class="abox">→ ① <b>完整性保证本身的洞</b>被修掉（条款索引曾吞掉 A 草案 4 个装置共 71 条，我们曾在一个缺了四个装置的集合上宣称「真缺口 0」）<br/>
        ② 空缺必须是<b>有理由的空</b>（该版确实没规定），与「抽取失败」在报告里措辞不同；每个取值带条款号与页码，可逐条回源</div>
      <div class="qbox">③ 「后段条款对照，是大篇幅的段落摘取，也仅限于有数值的段落，且仅有两版国标，无欧标，只有罗列，无对比。」</div>
      <div class="abox">→ 附录 H <b>逐条并排</b>而非大段落罗列（差异处粗体标出）；第 14 章欧标第三列；第 12 章改<b>决策视图</b>（按「要不要动产品」分组），不再是三列罗列</div>`,
    endline: `每一句抱怨，下面都有一个<b>可以当场指着交付件某一页</b>回答的答案 —— 第 11 / 12 / 14 章与附录 H。`,
    note: `这页是全场最重要的一页 —— 逐条念客户原话，再念下面的答案。<b>顺序不要换</b>：先让他自己确认「对，就是这三条」，再给答案，否则他以为你在自说自话。`,
  }));

  // 4 为什么难
  pages.push(page({
    sec: "问题", num: "04", title: "为什么这件事本质上难：宁可空着，不可错着",
    body: `
      <p><b>定位不到（读者知道要自己去翻）和定位到错误（读者会当真），代价差一个数量级。</b></p>
      <h3>这轮我们真踩的三个坑（都不是模型能造出来的，也拦不住）</h3>
      <ul>
        <li><b>2.10 m 变成 10 m</b> —— 源 PDF 拆行造成的「宽度大于2.\\n10m」被当条款号碎片删掉，宽度门槛差一个数量级，<b>而它会原样印在客户手里</b></li>
        <li><b>A 草案 71 条条款被索引整段吞掉</b> —— 5.20 是无编号小节，序列从 5.19 跳到 5.21。我们曾在一个<b>缺了四个装置</b>的集合上宣称「真缺口 0」</li>
        <li><b>一份报告里两个数打架</b> —— 首页说「10 条待复核」，§11.0 说「0 条」。根因：§11.4 那 9 条是<b>已裁定</b>项，不是待办</li>
      </ul>
      <p style="margin-top:14px">这三条全部是被<b>机器闸门</b>抓住的，不是靠人眼看出来的。</p>`,
    endline: `所以这个项目的核心资产不是那份 PDF，<b>是那 ${GATES} 项闸门</b> —— 它们让下一版不可能再犯同样的错。`,
    note: `这一页的作用是<b>建立可信度</b>：不是辩解「我们已经很小心」，而是「我们踩过坑，而且坑现在有闸门盯着」。如果领导问「那你们怎么保证不会再犯」，直接翻到第 10 页。`,
  }));

  // 5 架构
  pages.push(page({
    sec: "架构", num: "05", title: "架构总览：一条确定性管线，模型不碰交付数据",
    fig: F("arch"), layout: "figshot",
    body: "",
    lead: "从上到下：源 PDF → 语料 → 参数 → 判定 → 呈现",
    note: `强调最后一句：<b>模型不在这条链上</b>。凡是会印进客户手里的数字，都走确定性抽取 + 机器回源。这是我们和"拿大模型写法规报告"的路线区别 —— 也是客户最后认了的那一点。`,
    shot: S1("p09_paramindex.png"),
    shotCaption: "第 12 章参数矩阵索引（交付件实际页面）",
  }));

  // 6 agentic loop
  pages.push(page({
    sec: "架构", num: "06", title: "Agentic loop 在哪里：网页端的取证问答",
    sub: "真 tool-calling，不是把工具列表贴给模型",
    fig: F("loop"), layout: "figshot",
    body: "",
    lead: "模型只负责「问对问题」，事实全部由工具回源取回",
    note: `这里回答领导最可能问的「你们到底用没用上 agent」。答案：用了，而且是真循环 —— 模型输出 tool_call，服务端执行工具，结果塞回对话继续下一轮。<b>关键设计是收口判定</b>：连续两轮什么都没查着就强制它据实收口，不许编。`,
    shot: S1("w02_trust.png"),
    shotCaption: "审阅工作台（网站实际界面）—— 可信度仪表盘",
  }));

  // 7 三明治
  pages.push(page({
    sec: "架构", num: "07", title: "取值规格提议 agent：三明治结构",
    sub: "模型只在中间一层",
    fig: F("sandwich"), layout: "figshot",
    body: "",
    lead: "候选从哪来、答案合不合格，全是代码说了算",
    note: `这是本项目最值得讲的一处设计。常见做法是"让模型直接抽参数"，结果不可复核。我们把它拆成四层，模型被夹在中间 —— 上下都有确定性关卡。<b>所以换模型、换标准都不影响可靠性</b>。右下角截图是这条流水线的人工确认页，现在挂着 48 行待裁定。`,
    shot: S1("w03_proposals.png"),
    shotCaption: "/proposals 参数提议确认页（48 行待裁定）",
  }));

  // 8 三层保障
  pages.push(page({
    sec: "可信度", num: "08", title: "可信度是怎么保证的：三层保障",
    sub: "每一层都对应一次真翻车",
    fig: F("layers"), layout: "fig",
    body: "",
    lead: "不是「我们保证了完整性」，而是「完整性由代码判定，判定结果由闸门守住」",
    note: `左边三行是机制，右边是它挡过的具体错误。<b>讲的时候把右边那几条念出来</b> —— 具体的错比抽象的机制有说服力得多。特别强调「2.10m 变成 10m」：这是会被客户拿到桌面上对着 R48 原文核的数。`,
  }));

  // 9 闸门
  pages.push(page({
    sec: "可信度", num: "09", title: "${GATES} 项闸门：改坏就红，不靠人盯",
    sub: "npm run verify —— 交付前的唯一判据",
    fig: F("gates"), layout: "fig",
    body: "",
    lead: "六段组成，从构建产物一直查到渲染出来的那份 PDF",
    note: `这一页是给领导吃定心丸的。<b>闸门不是文档承诺，是可执行检查</b> —— 当场就能跑。念一下最后一段：11 个 _test_*.mjs 名字像测试文件，其实是闸门本体，删一个 verify 就红。这是我们这轮清理文件时差点踩的坑。`,
  }));

  // 10 覆盖度
  pages.push(page({
    sec: "可信度", num: "10", title: "现在的硬指标",
    sub: "全部来自机器计算，不是人工填的",
    fig: F("metrics"), layout: "fig",
    body: "",
    lead: "数据取自 data/coverage-audit.json 与 data/requirement-ledger.json",
    note: `数字都在 data/ 下的机器产物里，可以现场打开给对方看。特别说明最后一块：957 个取值位里 787 有值，<b>剩下 170 格是「有理由的空」而不是抽取失败</b> —— 这正是「宁可空着，不可错着」的落地形态。诚实讲清楚，比报一个 100% 更站得住。`,
  }));

  // 11 客户抱怨兑现表
  pages.push(page({
    sec: "结果", num: "11", title: "三条抱怨 ↔ 现在的机制 ↔ 可当场验的判据",
    fig: F("complaints"), layout: "fig",
    body: "",
    lead: "最后一列是给验收方留的抓手",
    note: `如果只有时间讲一页，讲这一页。第三列是刻意留的 —— <b>让对方自己验，而不是我们说我们验了</b>。附录 H 那 517/517 和三版 missing 0 都是脚本跑出来的，对方可以要我们现场跑。`,
  }));

  // 12 交付件
  pages.push(page({
    sec: "结果", num: "12", title: "交付件长什么样",
    sub: "249 页 · 14 章 + 8 附录",
    layout: "shot",
    body: `
      <h3>结构</h3>
      <ul>
        <li><b>第 11 章 变化点总结</b>：§11.0 一份权威变化清单（17 条），全报告各处只报这一个数</li>
        <li><b>第 12 章 参数矩阵</b>：319 参数 × 3 版，每格带条款号 + 页码 + 原文，是唯一能支撑 C 定量判断的部分</li>
        <li><b>第 14 章 欧标对照</b>：UN R48-09 的条款号 + 页码 + 原文摘录</li>
        <li><b>附录 H 定性条款并排</b>：客户第一句抱怨的直接答复</li>
        <li><b>附录 E.5 要求台账</b>：448 条要求逐条归类，真缺口 0</li>
      </ul>`,
    note: `不要逐章念。挑客户最关心的两章讲：第 12 章（他要看数）和附录 H（他说没比过定性条款）。右边截图是第 12 章的实际页面 —— <b>指出每行末尾都有页码和条款号</b>，这是"可核验"的直观体现。`,
    shot: S1("p20_matrix.png"),
    shotCaption: "第 12 章参数矩阵（交付件实际页面）",
  }));

  // 13 附录 H
  pages.push(page({
    sec: "结果", num: "13", title: "附录 H：定性条款并排（客户第一句抱怨的答复）",
    layout: "shot",
    body: `
      <p><b>184 条逐条并排，差异处用粗体标出。</b>绝大多数差别只有一两个字（「挂车不应<b>安装</b>」→「挂车不应<b>使用</b>」），不给标记读者得逐字比对几百字中文。</p>
      <h3>三条安全边界</h3>
      <ul>
        <li><b>同号 ≠ 同条款</b> —— A 的 5.4 是前雾灯、B 的 5.4 是倒车灯。配对先过装置级重排表（11 条，回原文核验）</li>
        <li><b>款也要一致</b> —— 装置对了、款不对 → 判为编号重排，<b>不并排</b>（86 条）</li>
        <li><b>报告只判「同文 / 文字不同」</b>，不判「实质变化」—— 那是工程判断，报告不替读者下结论</li>
      </ul>`,
    note: `这一页讲给客户听最合适。重点讲「三条安全边界」—— 主动交代我们<b>没做什么</b>（86 条不并排、不判实质变化），比吹"我们全比了"更能建立信任。然后指着右边截图讲粗体标记。`,
    shot: S1("p238_appendixH.png"),
    shotCaption: "附录 H.2 定性条款并排（交付件实际页面）",
  }));

  // 14 投入产出
  pages.push(page({
    sec: "价值", num: "14", title: "投入产出：人工从「抄」挪到「判」",
    fig: F("roi"), layout: "fig",
    body: "",
    lead: "左列是过去必须人工做的事，右列是现在谁在做",
    note: `讲这一页是为了回答「这套东西值不值」。核心一句在下面：<b>人工没被替代，只是被挪到了该由人判断的地方</b> —— 条件方向相反的句子、工程影响、编号重排，这些机器判不了也不该判。这比"全自动化"更可信。`,
  }));

  // 15 现状缺口
  pages.push(page({
    sec: "现状", num: "15", title: "还没做的，和这套东西现在有多值钱",
    sub: "说清楚缺口，比藏着更有说服力",
    fig: F("gaps"), layout: "fig",
    body: "",
    lead: "左边是缺口，右边是可复用性 —— 这一页决定了下一步投什么",
    note: `主动讲缺口，是这场汇报最能加分的地方。<b>「/projects、/documents 是占位页」「Word 只导问答」「欧标条款级刻意不做」</b> —— 说在前面，显得你对边界有清醒认识；如果对方自己发现，你就变成"没交代"。右边那栏是回答"这套东西能不能用在别的标准上"：能，但必须另建一套 spec 包。`,
  }));

  // 16 下一步
  pages.push(page({
    sec: "下一步", num: "16", title: "下一步投什么：三个方向",
    fig: F("next"), layout: "fig",
    body: "",
    lead: "按「价值 / 成本」排序",
    note: `如果这次汇报要一个结论，就落在这页。<b>方向三成本最低、流程已跑通</b>（/proposals 现在就挂着 48 行待裁定，补齐只是产能问题）—— 适合马上批。方向二价值最高但要小心：限定词抽取必须回源复核，不能只靠正则。方向一工作量最大，属于出口欧盟时的刚需，可以等有明确订单。`,
  }));

  // 17 怎么用
  pages.push(page({
    sec: "使用", num: "17", title: "怎么用：命令行 + 网页",
    body: `
      <h3>网页（客户/业务自己用）</h3>
      <ul>
        <li><code>/</code> 上传三份源 PDF → 生成完整报告 → 下载 PDF（<b>249 页全文</b>）</li>
        <li><code>/review</code> 审阅工作台：可信度仪表盘、假差异逐条确认、网传指标证伪</li>
        <li><code>/proposals</code> 参数提议确认：agent 提的候选，逐条人工确认后才进数据</li>
      </ul>
      <h3 style="margin-top:12px">命令行（我们自己）</h3>
      <ul>
        <li><code>npm run verify</code> —— <b>交付闸门，${GATES} 项。改完必跑</b></li>
        <li><code>node rebuild_report.mjs</code> → <code>node render_to_pdfdir.mjs</code> —— 重建并出 PDF</li>
      </ul>`,
    endline: `红线只有一条：<b>verify 红了就不许交付</b>。其余都可以商量。`,
    note: `这页是给你自己看的 —— 汇报后同事会来问「怎么跑」。<b>npm start 在 Windows 上会失败</b>（环境变量语法），要用 NODE_ENV=production node dist/index.js。后面我在控制台给你完整演示。`,
  }));

  // 18 命令表
  pages.push(page({
    sec: "使用", num: "18", title: "命令速查",
    fig: F("cmds"), layout: "fig",
    body: "",
    lead: "六个命令覆盖从改代码到出交付件",
    note: `留作附录页。讲的时候一句话带过：「日常就这几个命令，verify 是红线 —— 红了不许交付。」`,
  }));

  // 19 结束
  pages.push(`
  <section class="page cover">
    <div class="eyebrow">下一步</div>
    <h1>我们不是在交一份报告<br/>是在交一条能重复跑、能追责的产线</h1>
    <div class="sub">
      现在这台机器能：吃进三份法规，吐出 249 页带页码的横向对比，<br/>
      并且在吐出之前自己证明自己没取错数、没编数、没把没规定的地方写成规定。
    </div>
    <div class="cards">
      <div class="card"><div class="v">方向三</div><div class="l">补齐 170 个「有理由的空」<br/>成本低 · 流程已跑通 · 建议马上批</div></div>
      <div class="card"><div class="v">方向二</div><div class="l">条件方向检查器<br/>价值最高 · 需要人工复核兜底</div></div>
      <div class="card"><div class="v">方向一</div><div class="l">定性并排扩到三方<br/>工作量最大 · 出口刚需</div></div>
    </div>
    <div class="note-band">
      <span class="nb-tag">讲解提示</span>
      <div class="nb-text">收尾只说两句话：① 这条产线已经能跑，我们打算让它更全；② 今天要一个方向三的产能批下来。其余细节留给会后。<b>不要在这里开始讲实现</b>。</div>
    </div>
  </section>`);

  return pages.join("\n");
}

// ── 作为库被复用 ──────────────────────────────────────────────────────────
// 精简版讲稿（render_briefing_15min.mjs）借这里的图表 HTML、样式与 page()
// 骨架，避免两套脚本各抄一份图 —— 抄一份就多一处会悄悄走样的地方。
// 设 BRIEFING_AS_LIB=1 导入本模块时，下面那段主流程不会执行。
export { C, SYSTEM_FONT_CSS, BASE_CSS, FIG, FIG_CSS, DECK_CSS, page, img, S, OUT, ASSETS, FIGDIR };

// ── 主流程 ────────────────────────────────────────────────────────────────
if (process.env.BRIEFING_AS_LIB !== "1") {
// 只检查系统字体在不在（不内嵌 —— 内嵌 97MB 会把 Chromium 撑爆）
const sysFonts = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simsun.ttc"];
const missingFonts = sysFonts.filter((f) => !fs.existsSync(f));
if (missingFonts.length) throw new Error(`系统缺中文字体：${missingFonts.join(", ")} —— 会把中文印成方块`);

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ channel: "chrome" });

try {
  const page = await browser.newPage({ viewport: { width: 1236, height: 900 }, deviceScaleFactor: 2 });

  // —— 第一遍：把每个图表渲染成 PNG ——
  const figData = {};
  for (const [key, html] of Object.entries(FIG)) {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${SYSTEM_FONT_CSS}${BASE_CSS}${FIG_CSS}</style></head><body>${html}</body></html>`;
    await page.emulateMedia({ media: "screen" });
    await page.setContent(doc, { waitUntil: "load", timeout: 60_000 });
    await page.evaluate(async () => {
      const fonts = document.fonts;
      if (fonts?.ready) await fonts.ready;
      for (const f of fonts ?? []) await f.load().catch(() => {});
    });
    const el = await page.$(".fig");
    const file = path.join(FIGDIR, `${key}.png`);
    await el.screenshot({ path: file });
    figData[key] = fs.readFileSync(file).toString("base64");
    console.log(`[fig] ${key}.png  base64头40=${figData[key].slice(0,40)}  长度=${figData[key].length}  文件=${file}`);
  }

  // —— 第二遍：组装讲稿页并出 PDF ——
  const deckHtml = buildDeck(figData);
  if (process.env.DUMP_DECK) fs.writeFileSync(process.env.DUMP_DECK, deckHtml, "utf-8");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>GB 4785 三版法规横向对比 · 项目宣讲</title>
    <style>${SYSTEM_FONT_CSS}${BASE_CSS}${DECK_CSS}</style></head><body>${deckHtml}</body></html>`;

  await page.emulateMedia({ media: "print" });
  await page.setContent(doc, { waitUntil: "load", timeout: 180_000 });
  await page.evaluate(async () => {
    const fonts = document.fonts;
    if (fonts?.ready) await fonts.ready;
    for (const f of fonts ?? []) await f.load().catch(() => {});
  });
  await page.waitForTimeout(1200);

  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, "项目宣讲_GB4785三版对比_讲稿版_2026-10-28.pdf");
  await page.pdf({
    path: outFile,
    width: "13.333in",
    height: "7.5in",
    printBackground: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
    displayHeaderFooter: false,
  });
  console.log(`\n[briefing] ✅ ${outFile}`);
} finally {
  await browser.close();
}
}
