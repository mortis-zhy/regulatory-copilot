import asyncio
import json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        context = await browser.new_context(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
        page = await context.new_page()

        # Capture the PDF request body
        pdf_request_body = None
        async def handle_route(route):
            nonlocal pdf_request_body
            request = route.request
            if "/api/agent/report/pdf" in request.url:
                try:
                    pdf_request_body = request.post_data
                except: pass
            await route.continue_()
        await page.route("**/api/agent/report/pdf", handle_route)

        await page.goto("http://localhost:3000/?v=5555", wait_until="networkidle")
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

        import time
        start = time.time()
        while time.time() - start < 240:
            btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
            if btns:
                break
            await page.wait_for_timeout(2000)

        if not btns:
            print("❌ no download button")
            await browser.close()
            return

        await btns[-1].scroll_into_view_if_needed()
        await page.wait_for_timeout(500)
        await btns[-1].click()

        # Wait for request to be intercepted
        for _ in range(30):
            if pdf_request_body: break
            await page.wait_for_timeout(500)

        if pdf_request_body:
            try:
                payload = json.loads(pdf_request_body)
                print(f"\n=== 发送到 /api/agent/report/pdf 的 payload ===")
                print(f"  content 长度: {len(payload.get('content', ''))}")
                print(f"  summary 长度: {len(payload.get('summary', ''))}")
                print(f"  changes: {len(payload.get('changes', []))}")
                print(f"  parameters: {len(payload.get('parameters', []))}")
                print(f"  evidence: {len(payload.get('evidence', []))}")
                print(f"  sourceDocuments: {len(payload.get('sourceDocuments', []))}")
                print(f"\n=== content 前 800 字符 ===")
                print(payload.get('content', '')[:800])
                with open("C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/payload.json", "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print("Parse error:", e)
                print(pdf_request_body[:1000])
        else:
            print("❌ No request body captured")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
