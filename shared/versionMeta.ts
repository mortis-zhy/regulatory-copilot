/**
 * 版本的**声明式显示名表** —— 从 `data/standard-pack.json` 读。
 *
 * ## 为什么在 `shared/` 而不是 `server/reports/`
 *
 * 客户端与服务端**读的是同一份声明**：
 * 服务端用它渲染报告，客户端用它认「这套装是不是本标准」、显示版本显示名。
 * 两边各写一份查找逻辑，迟早漂移 —— 而漂移的表现是
 * 「界面上的版本名和报告里的不一样」，**谁都不会发现**。
 *
 * 它仍然**不 import 整份 spec**（八百多条正则）——
 * 只 import 一个几 KB 的 JSON，所以两边都拖得起。
 *
 * ## 为什么单独成文件
 *
 * 原来它在 `parameterMatrix.ts` 里。而 `parameterMatrix.ts` 会 import
 * 整份 `data/parameter-specs.json`（八百多条正则）。
 * 于是**只想拿一张显示名表**的模块（`typedTables.ts`）也被迫拖上整份 spec ——
 * 打包出来的 `dist/typedTables.js` 有多大，跟它要干什么毫无关系。
 *
 * 现在这张表独立：想用它的人 import 它，不需要碰 spec。
 *
 * ## 为什么数据在 JSON 里而不是在这个 .ts 里
 *
 * 因为**它就是内容**。
 *
 * 以前这张表是 12 行硬编码字面量，换标准时得改代码；
 * 现在它声明在 `data/standard-pack.json` 里 ——
 * **换标准 = 改一个 JSON，代码一行不动。**
 *
 * 这是「内容层」与「机制层」的分界在代码里的落点：
 * 机制（怎么取数、怎么对照、怎么渲染）不认标准；
 * 内容（这几份文件各叫什么）全在声明里。
 *
 * ## 一张表装下「关于这个标准，报告需要知道的一切」
 *
 * | 字段 | 是什么 | 谁在用 |
 * |---|---|---|
 * | `label` | 短标签（表头、章节标题） | 渲染层 |
 * | `desc` | 一句话说明 | 执行摘要 |
 * | `doc` | **文档显示名**（不含页数） | 源文档清单 → **下载文件名** |
 * | `std` | 标准号（概况表那一列） | 第 2 章概况表 |
 * | `status` | 状态（草案/现行/国际法规…） | 第 2 章概况表 |
 *
 * **页数不在这里** —— 页数是**语料的事实**，不是声明：
 * 它从分页文本数出来（见 reportV6 的 `pageCountsOf`）。
 * 写死的页数换一套标准就全错，而且**不报错**：报告照出，只是页数在骗人。
 */
import PACK_JSON from "../data/standard-pack.json";

/**
 * 版本键。
 *
 * **不要写死成 `"A" | "B" | "C"`** ——
 * 那个类型曾经散落在 `typedTables.ts` 与 `htmlRenderV8.ts` 里，
 * 而版本键本来就该由**语料推导**（`versionsOf`），
 * 探针里跑的是四版（X/Y/Z），写死的类型只是「恰好能编译」。
 */
export type VersionKey = string;

export type VersionMeta = {
  key: VersionKey;
  label: string;
  /** 卡片上的短标签（「草案」「现行」「UN」）—— 也是表头里的那截。 */
  short: string;
  desc: string;
  doc: string;
  std: string;
  status: string;
  /** 修订号：「V4.3.5」「2019」「09」。 */
  rev: string;
  /** 这一版的**角色**（「新版」「现行」「国际参照」）—— 提示词里用它。 */
  role?: string;
  /** 角色的长说法（「新版，待发布」「国际法规，只做参照」）。 */
  roleNote?: string;
  /** **正文里**用的文档名（「GB 4785 草案」）—— 与 `doc` 未必一样。 */
  docInText?: string;
  /**
   * 读者**查证时的先后顺序**（免责说明按这个顺序列标准）。
   *
   * 现行版排前面 —— 读者最常查的是「现在该怎么做」。
   * 这是一个**内容判断**（不是机制），所以放在声明里。
   */
  consultOrder?: number;
  /** 封面副标题里的**角色词**（「草案版」「现行版」「欧版」）。 */
  coverRole?: string;
  /** 封面卡片上的那一行副标题（「原文 PDF」「国际法规原文」）。 */
  cardMeta?: string;
  /** 封面卡片上的文档名 —— 语料没有清单时用的兜底。 */
  cardName?: string;
};

export const VERSION_META: ReadonlyArray<VersionMeta> = (
  (PACK_JSON as unknown as { versions?: VersionMeta[] }).versions ?? []
);

/**
 * 当前语料里**实际有几版**。
 *
 * 渲染层的版本列识别按它走，**不写死 A/B/C** ——
 * 换一套标准（X/Y/Z）或加第四版时，对照表与卡片布局都会跟着变，
 * 而不是把新版本悄悄丢掉。
 *
 * 放在这里而不是渲染器里，是因为**两个模块都要用**：
 * 渲染层（卡片布局、版本列识别）与表格分类器（横向对照表找版本列）。
 * 放在渲染器里的话，表格分类器就只能继续写死 A/B/C。
 */
let ACTIVE_VERSIONS: string[] = VERSION_META.map((m) => m.key);
export function setActiveVersions(v: string[]): void {
  const clean = (v ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (clean.length) ACTIVE_VERSIONS = clean;
}
export function activeVersions(): string[] {
  return [...ACTIVE_VERSIONS];
}

/** Display label for a version key; unknown keys fall back to the key itself. */
export function versionLabel(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.label ?? v;
}

/** 这一版的**文档显示名**（不含页数）—— 源文档清单与下载文件名都从它派生。 */
export function versionDoc(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.doc ?? String(v);
}

/** 这一版的**标准号**（第 2 章概况表那一列）。 */
export function versionStd(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.std ?? String(v);
}

/** 这一版的**一句话说明**（执行摘要与「本章范围」那几行用它）。 */
export function versionDesc(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.desc ?? String(v);
}

/** 这一版的**修订号**（「V4.3.5」「2019」「09」）。 */
export function versionRev(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.rev ?? "";
}

/**
 * 剥掉末尾的**修订号**。
 *
 * 按声明里的 `rev` 字段**精确**剥，不靠正则猜 ——
 * 「V4.3.5」「2019」「09」三种写法长得完全不一样，
 * 用一条正则去猜，迟早把标准号的一部分也削掉。
 */
function stripRev(text: string, v: string): string {
  const rev = (VERSION_META.find((m) => m.key === v)?.rev ?? "").trim();
  if (!rev) return text;
  // 转义正则元字符：修订号里有 `.`（V4.3.5），不转义就会变成通配。
  const esc = rev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 模板字符串里 `\s` 会被当成普通字符 —— 要写 `\\s`。
  return text.replace(new RegExp(`[-–—\\s]*${esc}\\s*$`), "").trimEnd();
}

/**
 * 版本标签去掉末尾的修订号：「C UN R48-09」→「C UN R48」。
 *
 * 报告里说的是「**UN R48** 的条款」—— 指的是**那部法规**，
 * 不是它的第 09 号修订件。两者在法规上不是一回事。
 */
export function versionLabelNoRev(v: string): string {
  return stripRev(versionLabel(v), v);
}

/**
 * 文档名的**紧凑写法**：「GB 4785-2019」→「GB4785-2019」。
 *
 * 两套写法都在用 —— 正式行文用带空格的（「GB 4785-2019」），
 * 文件名与表头里那一截用紧凑的（「GB4785-2019」）。
 * 所以两种都得有：不能一处一种、另一处另一种。
 */
export function versionDocKey(v: string): string {
  return versionDoc(v).replace(/\s/g, "");
}

/** 文档名去掉末尾的修订号：「GB 4785 草案 V4.3.5」→「GB 4785 草案」。 */
export function versionDocNoRev(v: string): string {
  return stripRev(versionDoc(v), v);
}

/**
 * 各版本的**键**（按声明顺序）—— 「A」「B」「C」。
 *
 * 键本身也是内容（换一套标准可能叫 X/Y/Z），
 * 所以要写「仅 A 与 B 两版」这种话，也得从声明里取。
 */
export function versionKeys(): string[] {
  return VERSION_META.map((m) => m.key);
}

/** 这一版的**状态**（第 2 章概况表那一列）。 */
export function versionStatus(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.status ?? "";
}

/**
 * 第 i 版（0 起）的键 —— 「A」「B」「C」。
 *
 * 写死 "C" 的地方（「C 列」「C 参照」）在换标准后会**指着不存在的那一列**说话，
 * 而那不会报错：表格少一列，报告照出，读者只会以为那一版没改。
 * 所以按**位置**取键；取不到就是空串 —— 宁可空着，不可错着。
 */
export function versionKeyAt(i: number): string {
  return VERSION_META[i]?.key ?? "";
}

/**
 * 文档名去掉**标准族前缀**：「GB 4785 草案 V4.3.5」→「草案 V4.3.5」。
 *
 * 有些句子里的标准名是**省略**的（「A（草案 V4.3.5）」而不是「A（GB 4785 草案 V4.3.5）」）。
 * 省略的那一截要由声明推出来，不能由代码写死。
 */
export function versionDocNoFamily(v: string): string {
  const fam = (PACK_JSON as unknown as { standardFamily?: string }).standardFamily ?? "";
  const doc = versionDoc(v);
  return fam && doc.startsWith(fam) ? doc.slice(fam.length).trim() : doc;
}

/**
 * 「参照」角色的列名：「C 参照」。
 *
 * 末版只作参照、不参与变化判定 —— 这个说法是**列的性质**，不是标准名，
 * 所以由键拼出来：换一套标准，「C 参照」会自己变成「X 参照」。
 */
export function versionRefLabel(v: string): string {
  return `${v} 参照`;
}

/**
 * 这一版的**角色**（「新版」「现行」「国际参照」）。
 *
 * 角色是**这一版在本报告里扮演什么**，不是它叫什么 ——
 * 提示词里要写清楚「A 是新版，B 是现行，C 只作参照」，
 * 写死了换标准就会把新版与现行说反。
 */
export function versionRole(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.role ?? "";
}

/** 角色的长说法（「新版，待发布」）。 */
export function versionRoleNote(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.roleNote ?? versionRole(v);
}

/**
 * **正文里**用的文档名（「GB 4785 草案」）。
 *
 * 与 `doc`（「GB 4785 草案 V4.3.5」）未必一样：
 * 正文里提「草案」时通常不写修订号，而文件名要写全。
 * 两种都得有 —— 不能一处一种、另一处另一种。
 */
export function versionDocInText(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.docInText ?? versionDoc(v);
}

/**
 * 封面副标题里的**角色词**（「草案版」「现行版」「欧版」）。
 *
 * 这一行是**这一套标准特有的叫法** ——
 * 「欧版」预设了第三版是欧标，换成别的标准集就不该这么叫。
 */
export function versionCoverRole(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.coverRole ?? VERSION_META.find((m) => m.key === v)?.short ?? versionLabel(v);
}

/** 这一版的**查证顺序**（免责说明里按它排序）。 */
export function versionConsultOrder(v: string): number {
  return VERSION_META.find((m) => m.key === v)?.consultOrder ?? 99;
}

/**
 * 各版本按**查证顺序**排好的键（现行版在前）。
 *
 * 免责说明里那串标准名要按这个顺序列 ——
 * 顺序变了读者会觉得「怎么先列了草案版」。
 */
export function versionKeysByConsultOrder(): string[] {
  return [...VERSION_META]
    .sort((a, b) => (a.consultOrder ?? 99) - (b.consultOrder ?? 99))
    .map((m) => m.key);
}

/** 封面卡片上的那一行副标题（声明里的 `cardMeta`）。 */
export function versionCardMeta(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.cardMeta ?? "";
}

/** 封面卡片上的文档名（声明里的 `cardName`；没声明就用文档名）。 */
export function versionCardName(v: string): string {
  return VERSION_META.find((m) => m.key === v)?.cardName ?? versionDoc(v);
}

/**
 * 语料**没有**源文档清单时的兜底卡片。
 *
 * 以前这里是三行字面量（"A" / "GB 4785 草案" / …）——
 * 那是**报告里唯一一处不依赖语料的版本清单**，
 * 换标准后它会变成「三张 GB 4785 的卡片」摆在**别的标准**的报告封面上。
 */
export function fallbackSourceCards(): Array<{ label: string; name: string; meta: string }> {
  return VERSION_META.map((m) => ({ label: m.key, name: m.cardName ?? m.doc, meta: "" }));
}

/**
 * 把一个「显示名/文档名」归一化成可比较的形态：
 * 去空白、去下划线、去反引号、转大写。
 *
 * 「GB 4785 草案 V4.3.5」→「GB4785草案V4.3.5」
 */
export function normVersionText(s: string): string {
  return (s ?? "")
    .replace(/\*/g, "")
    .replace(/[`_\s　]/g, "")
    .trim()
    .toUpperCase();
}
