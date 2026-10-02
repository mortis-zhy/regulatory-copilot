"""Inspect actual PDF request payload."""
import asyncio
import json
import time
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        ctx = await browser.new_context(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
        page = await ctx.new_page()

        pdf_body = None

        async def handle(route):
            nonlocal pdf_body
            request = route.request
            if "/api/agent/report/pdf" in request.url:
                pdf_body = request.post_data
            await route.continue_()

        await page.route("**/api/agent/report/pdf", handle)

        await page.goto("http://localhost:3000/?v=3333", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        fi = await page.query_selector('input[type="file"]')
        await fi.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        await page.wait_for_timeout(15000)

        ta = await page.query_selector('textarea')
        await ta.fill("请基于三份文件做多版本法规横向对比，输出至少 20 页内容充实的 PDF。")
        await page.keyboard.press("Enter")

        start = time.time()
        while time.time() - start < 200:
            btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
            if btns:
                break
            await page.wait_for_timeout(2000)

        await page.wait_for_timeout(3000)
        await btns[-1].click()

        for _ in range(30):
            if pdf_body:
                break
            await page.wait_for_timeout(500)

        if pdf_body:
            obj = json.loads(pdf_body)
            print("PDF payload:")
            print("  content length:", len(obj.get("content", "")))
            print("  summary length:", len(obj.get("summary", "")))
            print("  changes:", len(obj.get("changes", [])))
            print("  parameters:", len(obj.get("parameters", [])))
            print("  evidence:", len(obj.get("evidence", [])))
        else:
            print("not captured")

        await browser.close()


asyncio.run(main())
