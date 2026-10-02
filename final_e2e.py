"""
Final E2E: 3 real demo PDFs in real Chrome.
  1. Upload, ask, wait for the streamed answer to COMPLETE
  2. Verify: no blank runs, findings cards + follow-up buttons, click 追问
  3. Download the response PDF and verify its contents
"""
import asyncio
import json
import time
from pathlib import Path
import pypdf
from playwright.async_api import async_playwright

ROOT = Path(__file__).parent
OUT = ROOT / "final"
OUT.mkdir(exist_ok=True)

PDFS = [
    "C:/Users/zsndz/Desktop/comparison_agent-main/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "C:/Users/zsndz/Desktop/comparison_agent-main/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C:/Users/zsndz/Desktop/comparison_agent-main/UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
]


async def main():
    async with async_playwright() as p:
        print("=" * 62)
        print("最终测试 · 真实 Chrome · 三份真实 PDF")
        print("=" * 62)
        browser = await p.chromium.launch(headless=False, channel="chrome")
        context = await browser.new_context(
            viewport={"width": 1500, "height": 1000},
            accept_downloads=True,
        )
        page = await context.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", e))

        await page.goto(
            f"http://localhost:3000/?v={int(time.time()*1000)}",
            wait_until="domcontentloaded",
            timeout=60000,
        )
        await page.wait_for_timeout(3000)
        print(f"[1] 打开页面: {await page.title()}")

        # ---- 1. upload ----
        fi = await page.query_selector('input[type="file"]')
        await fi.set_input_files(PDFS)
        for i in range(60):
            body = await page.evaluate("() => document.body.innerText")
            if "86k" in body and "65k" in body and "301k" in body:
                print(f"[2] ✅ 三份全量读取: 86k + 65k + 301k ({i}s)")
                break
            await page.wait_for_timeout(1000)
        await page.screenshot(path=str(OUT / "01-uploaded.png"))

        # ---- 2. ask + wait until answer COMPLETE (follow-up buttons are the signal) ----
        ta = await page.query_selector('textarea')
        await ta.fill("请对比这三份法规的关键差异：章节结构、新增/修改/删除条款、关键参数（光强、频率、尺寸），每条给出原文锚点。")
        await page.keyboard.press("Enter")
        print("[3] 提问，等待回答完成（最长 8 分钟，追问按钮出现 = 完成）...")
        t0 = time.time()
        follow = []
        while time.time() - t0 < 480:
            follow = await page.query_selector_all('button:has-text("追问")')
            if follow:
                break
            await page.wait_for_timeout(2000)
        elapsed = time.time() - t0
        if not follow:
            print("  ❌ 超时，未见追问按钮")
            await page.screenshot(path=str(OUT / "fail.png"), full_page=True)
            await browser.close()
            return
        await page.wait_for_timeout(3000)
        print(f"  ✅ 回答完成 ({elapsed:.0f}s), 追问按钮: {len(follow)} 个")

        # ---- 3. verify no blank runs + findings present ----
        ws = await page.evaluate("""
            () => {
                let empty = 0, runs = 0, maxRun = 0, maxAt = -1;
                const prs = document.querySelectorAll('.rc-prose');
                for (const pr of prs) {
                    for (const el of pr.querySelectorAll('p, div, span')) {
                        if ((el.textContent || '').trim() === '' && !el.querySelector('*')) {
                            if (getComputedStyle(el).display !== 'none') empty++;
                        }
                    }
                    const lines = (pr.innerText || '').split('\\n');
                    let cur = 0;
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].trim() === '') {
                            cur++;
                            if (cur > maxRun) { maxRun = cur; maxAt = i; }
                        } else { if (cur >= 3) runs++; cur = 0; }
                    }
                }
                let ctx = '';
                if (prs.length && maxAt >= 0) {
                    const lines = (prs[prs.length - 1].innerText || '').split('\\n');
                    ctx = lines.slice(Math.max(0, maxAt - 4), maxAt + 4)
                        .map(l => '[' + (l.slice(0, 70) || '(空)') + ']').join('\\n');
                }
                return { empty, runs, maxRun, ctx };
            }
        """)
        print(f"[4] 空白检查: 可见空元素 {ws['empty']} | 3+连续空行段 {ws['runs']} | 最大连续 {ws['maxRun']}")
        if ws.get("ctx"):
            print("    最大空白段上下文:")
            for l in ws["ctx"].split("\n"):
                print("      " + l)

        await page.screenshot(path=str(OUT / "02-answer.png"), full_page=True)

        # ---- 4. click 追问 → a NEW user message must appear (proves real follow-up) ----
        print("[5] 点击追问按钮")
        await follow[0].scroll_into_view_if_needed()
        await follow[0].click(timeout=5000)
        start = time.time()
        asked = False
        while time.time() - start < 30:
            b = await page.evaluate("() => document.body.innerText")
            if "原文锚点和详细依据" in b:
                asked = True
                break
            await page.wait_for_timeout(500)
        print(f"  {'✅' if asked else '❌'} 追问消息已发出")
        # wait for the follow-up answer: the button count must STOP changing
        # (streaming re-renders the last message, which invalidates element handles)
        prev = -1
        stable_since = None
        while time.time() - start < 360:
            cur = len(await page.query_selector_all('button:has-text("追问")'))
            if cur > prev:
                prev = cur
                stable_since = time.time()
            elif stable_since and time.time() - stable_since > 8:
                print(f"  ✅ 追问回答完成（按钮稳定 {prev} 个）")
                break
            await page.wait_for_timeout(2000)
        await page.screenshot(path=str(OUT / "03-followup.png"), full_page=True)

        # ---- 5. download response PDF ----
        print("[6] 下载回答 PDF")
        dl_btns = await page.query_selector_all('button[aria-label="下载 PDF"]')
        if not dl_btns:
            print("  ❌ 无下载按钮")
            await browser.close()
            return
        # Use force=True: the fixed composer can overlap the last bubble's button
        await dl_btns[0].scroll_into_view_if_needed()
        async with page.expect_download(timeout=120000) as di:
            await dl_btns[0].click(force=True, timeout=10000)
        dl = await di.value
        pdf_path = OUT / "回答PDF.pdf"
        await dl.save_as(str(pdf_path))
        size = pdf_path.stat().st_size
        print(f"  ✅ 下载: {size/1024/1024:.2f} MB")

        # verify pdf
        r = pypdf.PdfReader(str(pdf_path))
        full = "".join((pg.extract_text() or "") for pg in r.pages)
        print(f"[7] PDF 内容: {len(r.pages)} 页, {len(full)} 字符")
        for k in ["一、", "对比范围", "分析正文", "GB 4785", "UN R48", "目录", "附录"]:
            print(f"    {'✅' if k in full else '❌'} {k}")

        await page.screenshot(path=str(OUT / "04-final.png"), full_page=True)
        print("=" * 62)
        print("全部测试完成")
        print("=" * 62)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
