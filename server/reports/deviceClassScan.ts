/**
 * Device-class detector — scans the source text for known new device classes
 * (ADS 标志灯 / 驾驶员辅助投射 / 发光徽标 / etc.) that A 草案 introduced but
 * B 现行 doesn't have.
 *
 * Why this exists instead of chapterScan: A and B don't carry usable
 * embedded TOCs, and heuristic chapter detection from extracted text is
 * too noisy (a regex like `^6 从属功能` matches both real headings and
 * sub-clause body text). A pre-curated list of new device-class names is
 * far more reliable for this specific question.
 *
 * Pure derived data — no LLM.
 */

export type DeviceClassHit = {
  /** Canonical name as it should appear in the report. */
  name: string;
  /** The marker phrase(s) we search for in A's text. */
  markers: string[];
  /** The A clause / sub-section where this device class first appears. */
  clauseHint: string;
  /** Tag for the device category. */
  category: "matrix-light" | "adas" | "comfort" | "diagnostic" | "smart";
};

/** Curated list, cross-checked against GB 4785 草案 V4.3.5's actual section
 *  headings. A's terminology (e.g. "带有自适应模式的前照灯" instead of
 *  "ADB", "像素" instead of "Matrix LED") was used wherever possible so
 *  the markers match the actual extracted text. */
const DEVICE_CLASSES: DeviceClassHit[] = [
  {
    name: "ADB 系统（带有自适应模式的前照灯）",
    markers: ["带有自适应模式的前照灯", "自适应前照"],
    clauseHint: "5.3",
    category: "adas",
  },
  // REMOVED (false positive, v6.10 audit): "矩阵式 LED 前照灯" — "矩阵式"
  // appears 0× in both A and B; the only trigger was a single "像素" mention
  // inside the 3.2.1.3 terminology note ("注:灯丝、发光颗粒、像素"), not a
  // device-class section. Never invent sections that the TOC doesn't have.
  {
    name: "ADS 标志灯（自动化驾驶标志灯）",
    markers: ["ADS标志灯", "自动化驾驶", "AV1", "AV2", "AV3"],
    clauseHint: "5.24",
    category: "adas",
  },
  {
    name: "驾驶员辅助投射功能",
    markers: ["驾驶员辅助投射"],
    clauseHint: "6.1",
    category: "adas",
  },
  {
    name: "光信号投射功能",
    markers: ["光信号投射"],
    clauseHint: "6.2",
    category: "adas",
  },
  {
    name: "图文交互功能",
    markers: ["图文交互"],
    clauseHint: "6.3",
    category: "adas",
  },
  {
    name: "发光徽标",
    markers: ["发光徽标"],
    clauseHint: "6.4",
    category: "comfort",
  },
  {
    name: "外部状态指示器",
    markers: ["外部状态指示器"],
    clauseHint: "3.1.34",
    category: "comfort",
  },
  {
    name: "外部氛围功能",
    markers: ["外部氛围"],
    clauseHint: "3.1.33",
    category: "comfort",
  },
];

export type DetectedDeviceClass = {
  name: string;
  clauseHint: string;
  category: DeviceClassHit["category"];
  /** Whether the device class was found in B's text (B = GB 4785-2019). */
  presentInB: boolean;
  /** Page reference where A first mentions the device class. */
  aPage: string;
};

export function detectDeviceClasses(aText: string, bText: string): DetectedDeviceClass[] {
  const out: DetectedDeviceClass[] = [];
  for (const d of DEVICE_CLASSES) {
    const inA = d.markers.some((m) => aText.includes(m));
    if (!inA) continue;
    const inB = d.markers.some((m) => bText.includes(m));
    out.push({
      name: d.name,
      clauseHint: d.clauseHint,
      category: d.category,
      presentInB: inB,
      aPage: findFirstPage(aText, d.markers[0]),
    });
  }
  return out;
}

function findFirstPage(text: string, marker: string): string {
  // For a device class, we want the page where it's *defined*, not where
  // it's mentioned in the TOC. The TOC usually appears at the very start
  // of the document; the actual definition is much later. Walk all pages,
  // collect every page where the marker appears, then return the LAST one
  // (which is most likely the substantive definition).
  const lines = text.split("\n");
  let currentPage = "";
  const hits: string[] = [];
  for (const line of lines) {
    const pm = line.match(/^\[第(\d+)页\]/);
    if (pm) {
      currentPage = `第${pm[1]}页`;
      continue;
    }
    if (line.includes(marker) && currentPage) hits.push(currentPage);
  }
  return hits.length > 0 ? hits[hits.length - 1] : "—";
}

/** Convert to ChapterChange-like shape for use in 11.1 / 11.5. */
export function deviceClassesAsChapterChanges(
  devs: DetectedDeviceClass[],
): Array<{ number: string; level: "section"; title: string; page: string; cTitle?: string; cPage?: string }> {
  return devs
    .filter((d) => !d.presentInB)
    .map((d) => ({
      number: d.clauseHint,
      level: "section" as const,
      title: d.name,
      page: d.aPage,
    }));
}