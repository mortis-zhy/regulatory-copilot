import asyncio
import time
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        context = await browser.new_context(viewport={"width": 1500, "height": 1000})
        page = await context.new_page()

        # Capture all SSE chunks
        chunks = []

        async def handle_response(route):
            response = await route.fetch()
            if "chat/stream" in response.url:
                body = await response.body()
                text = body.decode("utf-8", errors="replace")
                # Count done events and content chunks
                done_count = text.count('"done":true')
                chunk_count = text.count('"content":')
                error_count = text.count('"error":')
                full_len = 0
                for line in text.split("\n"):
                    if line.startswith("data:"):
                        try:
                            import json
                            d = json.loads(line[5:].strip())
                            if d.get("content"):
                                full_len += len(d["content"])
                        except: pass
                print(f"=== 响应 ===")
                print(f"  SSE 行数: {len([l for l in text.split(chr(10)) if l.startswith('data:')])}")
                print(f"  'done':true 出现次数: {done_count}")
                print(f"  'content' 出现次数: {chunk_count}")
                print(f"  'error' 出现次数: {error_count}")
                print(f"  累积 content 长度: {full_len}")
            await route.fulfill(response=response)

        await page.route("**/api/agent/chat/stream", handle_response)

        await page.goto("http://localhost:3000/?v=7777", wait_until="networkidle")
        await page.wait_for_timeout(2000)

        file_input = await page.query_selector('input[type="file"]')
        await file_input.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        await page.wait_for_timeout(15000)

        textarea = await page.query_selector('textarea')
        await textarea.fill(
            "请基于三份文件的实际文本内容，逐章、逐条对比以下维度并给出具体页码和章节锚点：\n"
            "1) 章节结构差异 2) 新增灯具类型 3) 关键参数对比 4) 强制性 vs 推荐性 5) 过渡条款\n"
            "请务必引用原文条款编号。"
        )
        await page.keyboard.press("Enter")

        # Wait until status changes to "complete"
        start = time.time()
        while time.time() - start < 200:
            thinking = await page.query_selector('text= Copilot 正在分析')
            if not thinking:
                print(f"\n✅ 流式完成 (用时 {time.time()-start:.0f}s)")
                break
            await page.wait_for_timeout(2000)
        else:
            print(f"\n❌ 200s 超时")

        await page.wait_for_timeout(3000)

        # Check the actual message text length
        prose_len = await page.evaluate("""
            () => {
                const divs = document.querySelectorAll('.rc-prose');
                let total = 0;
                for (const d of divs) total += (d.textContent || '').length;
                return total;
            }
        """)
        print(f"  Prose textContent 总长: {prose_len} 字符")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
