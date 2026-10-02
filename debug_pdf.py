"""Debug what buildReportPayload sees when the download button is clicked."""
import asyncio
import time
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        ctx = await browser.new_context(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
        page = await ctx.new_page()

        logs = []
        page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

        await page.goto("http://localhost:3000/?v=4444", wait_until="networkidle")
        await page.wait_for_timeout(2000)

        fi = await page.query_selector('input[type="file"]')
        await fi.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        await page.wait_for_timeout(15000)

        ta = await page.query_selector('textarea')
        await ta.fill("请做多版本法规横向对比，至少 20 页内容。")
        await page.keyboard.press("Enter")

        start = time.time()
        btns = []
        while time.time() - start < 200:
            btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
            if btns:
                break
            await page.wait_for_timeout(2000)

        # Wait extra so React state fully settles
        await page.wait_for_timeout(5000)
        await btns[-1].click()
        await page.wait_for_timeout(3000)

        # Find the [PDF] log
        pdf_logs = [l for l in logs if "[PDF]" in l or "[streamChat]" in l or "[onDone]" in l]
        for l in pdf_logs:
            print("CONSOLE:", l)
        if not pdf_logs:
            print("所有 console 日志:")
            for l in logs[-10:]:
                print("  ", l)

        # Also query the message text length via DOM
        prose_text = await page.evaluate("""
            () => {
                const divs = document.querySelectorAll('.rc-prose');
                return Array.from(divs).map(d => (d.textContent || '').length);
            }
        """)
        print("DOM prose textContent lengths:", prose_text)

        await browser.close()


asyncio.run(main())
