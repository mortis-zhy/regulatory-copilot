import asyncio
import time
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        context = await browser.new_context(viewport={"width": 1500, "height": 1000})
        page = await context.new_page()

        # Capture raw SSE to disk
        async def handle_response(route):
            response = await route.fetch()
            if "chat/stream" in response.url:
                body = await response.body()
                with open("C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/raw-stream.txt", "wb") as f:
                    f.write(body)
            await route.fulfill(response=response)

        await page.route("**/api/agent/chat/stream", handle_response)

        await page.goto("http://localhost:3000/?v=6666", wait_until="networkidle")
        await page.wait_for_timeout(2000)

        file_input = await page.query_selector('input[type="file"]')
        await file_input.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        await page.wait_for_timeout(15000)

        textarea = await page.query_selector('textarea')
        await textarea.fill("请详细对比三份法规的章节结构和关键参数差异")
        await page.keyboard.press("Enter")

        start = time.time()
        while time.time() - start < 200:
            thinking = await page.query_selector('text= Copilot 正在分析')
            if not thinking:
                break
            await page.wait_for_timeout(2000)
        await page.wait_for_timeout(3000)

        # Dump full body text
        body = await page.evaluate("() => document.body.innerText")
        with open("C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/page-dom.txt", "w", encoding="utf-8") as f:
            f.write(body)

        print(f"DOM textContent: {len(body)} 字符")

        # Read raw stream and extract full content
        with open("C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/raw-stream.txt", "rb") as f:
            raw_bytes = f.read()
        raw_text = raw_bytes.decode("utf-8", errors="replace")

        import json
        full_content = ""
        for line in raw_text.split("\n"):
            if line.startswith("data:"):
                try:
                    d = json.loads(line[5:].strip())
                    if d.get("content"):
                        full_content += d["content"]
                except: pass

        print(f"原始 SSE content 累积: {len(full_content)} 字符")

        # Save full content for comparison
        with open("C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/full-content.txt", "w", encoding="utf-8") as f:
            f.write(full_content)

        # Compare first 1000 chars
        print("\n=== 原始 content 前 500 字符 ===")
        print(full_content[:500])
        print("\n=== DOM textContent 前 500 字符 ===")
        print(body[:500])

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
