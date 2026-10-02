"""Inspect actual SSE content length."""
import asyncio, json, time
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        ctx = await browser.new_context(viewport={"width": 1500, "height": 1000})
        page = await ctx.new_page()

        captured = []
        async def handle(route):
            resp = await route.fetch()
            if "chat/stream" in resp.url:
                body = await resp.body()
                captured.append(body.decode("utf-8", errors="replace"))
            await route.fulfill(response=resp)
        await page.route("**/api/agent/chat/stream", handle)

        await page.goto("http://localhost:3000/?v=2222", wait_until="networkidle")
        await page.wait_for_timeout(2000)

        fi = await page.query_selector('input[type="file"]')
        await fi.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        await page.wait_for_timeout(15000)

        ta = await page.query_selector('textarea')
        await ta.fill("请基于三份文件做多版本法规横向对比，至少 20 页内容充实的 PDF。先输出 markdown 表格，最后输出 JSON。")
        await page.keyboard.press("Enter")

        start = time.time()
        while time.time() - start < 200:
            btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
            if btns:
                break
            await page.wait_for_timeout(2000)

        await page.wait_for_timeout(3000)

        if captured:
            full = "".join(captured)
            text = ""
            for line in full.split("\n"):
                if line.startswith("data:"):
                    try:
                        j = json.loads(line[5:].strip())
                        if j.get("content"): text += j["content"]
                    except: pass
            print(f"流式累积 content 长度: {len(text)} chars")
            print(f"含 ```json: {text.count(chr(96)*3+'json')}")
            print(f"前 500: {text[:500]}")
            print(f"后 1000: {text[-1000:]}")
        else:
            print("没捕获到")

        await browser.close()

asyncio.run(main())
