"""
Generate a demo PDF using the three real demo documents, then inspect it.
"""
import asyncio
import time
from pathlib import Path
from playwright.async_api import async_playwright
import pypdf

DL_DIR = Path(__file__).parent / "demo"
DL_DIR.mkdir(exist_ok=True)
for f in DL_DIR.glob("*.pdf"):
    f.unlink()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
        context = await browser.new_context(
            viewport={"width": 1500, "height": 1000},
            accept_downloads=True,
        )
        page = await context.new_page()

        print("打开 localhost:3000 ...")
        await page.goto(f"http://localhost:3000/?v={int(time.time()*1000)}", wait_until="networkidle")
        await page.wait_for_timeout(2000)

        print("\n[1] 上传三份 PDF")
        file_input = await page.query_selector('input[type="file"]')
        await file_input.set_input_files([
            "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
            "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
        ])
        for i in range(60):
            body = await page.evaluate("() => document.body.innerText")
            if "86k" in body and "65k" in body and "301k" in body:
                print(f"   ✅ 三份全量读取 ({i}s)")
                break
            await page.wait_for_timeout(1000)

        print("\n[2] 问对比问题")
        textarea = await page.query_selector('textarea')
        await textarea.fill("请对比这三份法规的关键变化点、安装要求和适用范围")
        await page.keyboard.press("Enter")

        print("\n[3] 等待回答完成（最后一条有 PDF 下载按钮）")
        start = time.time()
        dl_btn = None
        while time.time() - start < 200:
            btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
            # 取最后一个（welcome 消息已被排除）
            if btns:
                dl_btn = btns[-1]
                break
            await page.wait_for_timeout(2000)
        if not dl_btn:
            print("   ❌ 下载按钮未出现")
            await browser.close()
            return
        print(f"   ✅ 回答完成 (用时 {time.time()-start:.0f}s)")

        # Screenshot showing the download button location
        await dl_btn.scroll_into_view_if_needed()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(DL_DIR / "demo-page.png"))
        print("   页面截图: demo/demo-page.png")

        # Click and download
        print("\n[4] 点击下载按钮")
        async with page.expect_download(timeout=90000) as download_info:
            await dl_btn.click()
        download = await download_info.value
        save_path = DL_DIR / "法规对比报告.pdf"
        await download.save_as(str(save_path))

        print(f"   ✅ 下载: {save_path.name} ({save_path.stat().st_size/1024/1024:.2f} MB)")

        # Verify content
        print("\n[5] PDF 内容验证")
        r = pypdf.PdfReader(str(save_path))
        full = "".join((p.extract_text() or "") for p in r.pages)
        print(f"   页数: {len(r.pages)}")
        print(f"   字符数: {len(full)}")
        sections = ["一、对比范围", "二、分析正文", "三、变化点总表", "四、专业参数", "五、联网调研证据", "六、审阅说明"]
        for s in sections:
            print(f"   {'✅' if s in full else '❌'} {s}")

        # Also screenshot the PDF first page as image for preview
        try:
            import subprocess
            subprocess.run(["powershell", "-Command", f"Start-Process '{save_path}'"], check=False)
        except Exception:
            pass

        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
