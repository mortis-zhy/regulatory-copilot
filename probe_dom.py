"""DOM geometry probe: find what element causes the visual blank above tables."""
import asyncio
import time
from playwright.async_api import async_playwright

PDFS = [
    "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        page = await (await browser.new_context(viewport={"width": 1500, "height": 1000})).new_page()
        await page.goto(f"http://localhost:3000/?v={int(time.time()*1000)}", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(3000)

        fi = await page.query_selector('input[type="file"]')
        await fi.set_input_files(PDFS)
        for i in range(60):
            b = await page.evaluate("() => document.body.innerText")
            if "86k" in b and "301k" in b:
                break
            await page.wait_for_timeout(1000)

        ta = await page.query_selector('textarea')
        await ta.fill("请对比三份法规的章节结构与关键参数")
        await page.keyboard.press("Enter")

        t0 = time.time()
        while time.time() - t0 < 480:
            if await page.query_selector_all('button:has-text("追问")'):
                break
            await page.wait_for_timeout(2000)
        await page.wait_for_timeout(3000)

        # Dump DOM geometry around the first table in the LAST .rc-prose
        info = await page.evaluate("""
            () => {
                const prs = document.querySelectorAll('.rc-prose');
                const pr = prs[prs.length - 1];
                if (!pr) return {err: 'no prose'};
                const tables = pr.querySelectorAll('table');
                const tbl = tables[0];
                if (!tbl) return {err: 'no table', html: pr.innerHTML.slice(0, 500)};
                const rect = tbl.getBoundingClientRect();
                const out = { tableTop: rect.top, tableH: rect.height, children: [] };
                // walk backwards from the table through the parent's previous siblings
                let node = tbl;
                const trail = [];
                for (let d = 0; d < 8 && node; d++) {
                    node = node.previousElementSibling;
                    if (!node) break;
                    const r = node.getBoundingClientRect();
                    trail.push({
                        tag: node.tagName,
                        h: Math.round(r.height),
                        text: (node.innerText || '').slice(0, 50).replace(/\\n/g, '|'),
                        display: getComputedStyle(node).display,
                    });
                }
                out.previousSiblings = trail;
                // parent chain heights
                let p = tbl.parentElement;
                const chain = [];
                for (let d = 0; d < 4 && p && p !== document.body; d++) {
                    const r = p.getBoundingClientRect();
                    chain.push({ tag: p.tagName, cls: (p.className || '').slice(0, 40), h: Math.round(r.height) });
                    p = p.parentElement;
                }
                out.parentChain = chain;
                // total prose height vs text length
                out.proseH = Math.round(pr.getBoundingClientRect().height);
                out.proseTextLen = (pr.innerText || '').length;
                out.tableCount = tables.length;
                out.innerHtmlHead = pr.innerHTML.slice(0, 600);
                return out;
            }
        """)
        import json as _j
        print(_j.dumps(info, ensure_ascii=False, indent=1)[:3000])
        await page.screenshot(path="probe-answer.png", full_page=False)
        await browser.close()


asyncio.run(main())
