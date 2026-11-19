#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""**部署自检** —— 在公司服务器上跑一次，就知道这台机器能不能出交付件 ✓。

## 为什么要有这个

「能跑起来」≠「能出交付件」✗ —— 本项目的出报告链路**真的会调 python** ✓
（抽图 / 裁字 / 渲染自检 / MinerU sidecar / 参数抽取 ✓），
而且**项目根**是靠 `data/parameter-specs.json` 认的 ✓（缺了它**启动即失败** ✗）。
这些在**服务器上**才会暴露 ✓ —— 与其上线后现场翻车，不如上线前先问一遍 ✓。

## 怎么读结果

- **✗ 阻断**（`ERROR`）—— 不修就出不了交付件 ✓；
- **⚠ 提醒**（`WARN`）—— 能跑，但某个能力**降级**了 ✓（说清降级成什么样 ✓）。

用法：
    python scripts/check_deploy.py            # 常规自检（秒级 ✓）
    python scripts/check_deploy.py --deep     # 加抽图/OCR 冒烟（慢：分钟级 ✓）
    python scripts/check_deploy.py --json     # 机器读（CI/验收单 ✓）
退出码：0 = 无阻断项 ✓；1 = 有阻断项 ✗
"""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env_file_values():
    """读仓库根的 `.env` ✓（服务器上多半是 `--env-file` 挂进来的 ✓）。

    为什么读文件而不是只看进程环境 ✓：进程环境里没有就是「没配」✗，
    而服务器上 `.env` **是**配置来源 ✓ —— 只看进程环境会**误报一堆缺配置** ✗。
    """
    out = {}
    p = os.path.join(ROOT, ".env")
    if not os.path.exists(p):
        return out
    try:
        for line in io.open(p, encoding="utf-8").read().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


_DOTENV = env_file_values()


def env(key):
    """进程环境优先 ✓；没有就看 `.env` ✓。"""
    v = os.environ.get(key)
    return v if v not in (None, "") else _DOTENV.get(key, "")


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, name, detail=""):
        self.items.append({"level": level, "name": name, "detail": detail})

    def ok(self, name, detail=""):
        self.add("ok", name, detail)

    def warn(self, name, detail=""):
        self.add("warn", name, detail)

    def error(self, name, detail=""):
        self.add("error", name, detail)

    @property
    def errors(self):
        return [i for i in self.items if i["level"] == "error"]

    @property
    def warns(self):
        return [i for i in self.items if i["level"] == "warn"]


def main():
    ap = argparse.ArgumentParser(description="部署自检")
    ap.add_argument("--deep", action="store_true", help="加抽图/OCR 冒烟（慢）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()
    r = Report()

    # ── 1. python 本身 ───────────────────────────────────────────────
    if sys.version_info < (3, 9):
        r.error("python 版本", "需要 ≥ 3.9，实测 %s" % ".".join(map(str, sys.version_info[:3])))
    else:
        r.ok("python 版本", "%s" % ".".join(map(str, sys.version_info[:3])))

    # ── 2. 运行时真会用的模块 ─────────────────────────────────────────
    for mod, why in [
        ("fitz", "抽图 / PDF 文本层 / 回源核对"),
        ("fontTools", "字体裁字（不裁字 ⇒ Chromium 在 100 MB 处崩）"),
        ("PIL", "图像处理（pHash / OCR）"),
        ("numpy", "图像处理（pHash / OCR）"),
    ]:
        try:
            __import__(mod)
            r.ok("模块 %s" % mod, why)
        except Exception as e:
            r.error("模块 %s" % mod, "**装不上 ⇒ 这条能力没有** ✗（%s）｜用途：%s" % (str(e)[:80], why))

    has_ocr = False
    try:
        import easyocr  # noqa: F401

        has_ocr = True
        r.ok("模块 easyocr", "图内数值（OCR）那一层可用 ✓")
    except Exception:
        r.warn(
            "模块 easyocr",
            "**没装** ⇒ 报告里「图内数值（OCR）」那一列**没有** ✗（其余多模态照常 ✓）；"
            "要装：pip install -r requirements-ocr.txt（含 torch ~2 GB）✓",
        )

    # ── 3. 项目根与目录 ──────────────────────────────────────────────
    if os.path.exists(os.path.join(ROOT, "data", "parameter-specs.json")):
        r.ok("项目根", ROOT)
    else:
        r.error(
            "项目根",
            "**data/parameter-specs.json 不在** ✗ —— 服务端靠它认项目根 ✓，"
            "缺了它**启动即失败** ✗（容器里忘了拷 data/ 就是这个症状 ✓）",
        )
    if os.path.isdir(os.path.join(ROOT, "scripts")):
        r.ok("scripts/", "python 脚本在 ✓")
    else:
        r.error("scripts/", "**缺 scripts/** ✗ —— 抽图/裁字/自检/抽取全跑不了 ✗")

    for rel in [
        "data/standard-pack.json",
        "data/parameter-specs.json",
        "data/device-chapter-map.json",
        "data/formula-symbols.json",
        "data/figure-limits.json",
        "data/report-prose.json",
        "reports/figure-hashes.json",
        "web/参数提议确认.html",
    ]:
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            r.ok("文件 %s" % rel)
        else:
            r.warn("文件 %s" % rel, "**不在** ✗ —— 对应能力会降级（不一定是阻断 ✓）")

    # ── 4. 语料（案例包的源 PDF）────────────────────────────────────
    up = os.path.join(ROOT, "uploaded-docs")
    pdfs = [f for f in os.listdir(up)] if os.path.isdir(up) else []
    pdfs = [f for f in pdfs if f.lower().endswith(".pdf")]
    if pdfs:
        r.ok("uploaded-docs/", "%d 份源 PDF ✓" % len(pdfs))
    else:
        r.warn(
            "uploaded-docs/",
            "**没有源 PDF** ✗ —— 出不了交付件 ✓（案例包的三份在仓库里 ✓，"
            "确认这个部署是从**仓库**构建的 ✓ 而不是从空目录 ✓）",
        )

    # ── 5. OCR 结果与图版是否同步 ───────────────────────────────────
    hp = os.path.join(ROOT, "reports", "figure-hashes.json")
    op = os.path.join(ROOT, "reports", "figure-ocr.json")
    if os.path.exists(hp):
        try:
            hashes = json.load(io.open(hp, encoding="utf-8"))
            n = len(hashes)
            if os.path.exists(op):
                ocr = json.load(io.open(op, encoding="utf-8"))
                imgs = ocr.get("images") or {}
                missing = [k for k in hashes if k not in imgs]
                if missing:
                    r.warn(
                        "图内 OCR 同步",
                        "%d 张图**没有** OCR 结果 ✗（跑 python scripts/ocr_figures.py ✓）" % len(missing),
                    )
                else:
                    r.ok("图内 OCR 同步", "%d 张图都有 OCR ✓" % n)
            else:
                r.warn("图内 OCR 同步", "**没有 reports/figure-ocr.json** ✗ ⇒ 那一层没有 ✓")
        except Exception as e:
            r.warn("图内 OCR 同步", "figure-hashes.json 读不了：%s" % str(e)[:80])
    else:
        r.warn("图内 OCR 同步", "**没有 reports/figure-hashes.json** ✗ ⇒ 多模态的图对比没有 ✓")

    # ── 6. 可写目录 ─────────────────────────────────────────────────
    for rel in ["uploaded-docs", "reports/tasks"]:
        p = os.path.join(ROOT, rel)
        try:
            os.makedirs(p, exist_ok=True)
            probe = os.path.join(p, ".write-probe")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("x")
            os.remove(probe)
            r.ok("可写 %s/" % rel)
        except Exception as e:
            r.error("可写 %s/" % rel, "**写不进去** ✗ —— 上传与报告落盘会失败 ✗（%s）" % str(e)[:80])

    # ── 7. 环境变量 ─────────────────────────────────────────────────
    pool = env("MODEL_KEY_POOL").strip()
    main_key = env("MINIMAX_API_KEY").strip()
    if pool or main_key:
        r.ok("模型凭据", "池子有 %d 项 ✓" % (len(pool.split(",")) if pool else 1))
    else:
        r.warn(
            "模型凭据",
            "**没有 MODEL_KEY_POOL / MINIMAX_API_KEY** ✗ ⇒ 问答与草稿模式**不可用** ✗"
            "（报告的确定性流水线不受影响 ✓）",
        )
    jwt = env("JWT_SECRET").strip()
    if len(jwt) >= 16:
        r.ok("JWT_SECRET", "已设 ✓")
    else:
        r.warn("JWT_SECRET", "**没设或太短** ✗ ⇒ 会话签名不安全 ✓（部署时生成随机串 ✓）")
    if env("DATABASE_URL").strip():
        r.ok("DATABASE_URL", "已设 ✓")
    else:
        r.warn("DATABASE_URL", "**没设** ✗ ⇒ 走 in-memory ⇒ **重启丢数据** ✗")
    font = env("REPORT_FONT_PATH").strip()
    if font and os.path.exists(font):
        r.ok("REPORT_FONT_PATH", font)
    else:
        r.warn(
            "REPORT_FONT_PATH",
            "**没设或指不到文件** ✗ ⇒ 渲染时字体回退 ⇒ 可能出豆腐块 ✗"
            "（容器里是 /usr/share/fonts/opentype/noto/NotoSansCJKsc-Light.otf ✓）",
        )
    port = env("PORT").strip() or "3000"
    if port.isdigit() and 1 <= int(port) <= 65535:
        r.ok("PORT", port)
    else:
        r.warn("PORT", "**不是合法端口** ✗（%r）" % port)

    # ── 8. 渲染用浏览器（**没有它就渲染不出 PDF** ✓）──────────────────
    exe = env("PLAYWRIGHT_EXECUTABLE_PATH").strip()
    chan = env("PLAYWRIGHT_CHANNEL").strip()
    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    has_chrome = any(os.path.exists(p) for p in chrome_paths)
    has_edge = any(os.path.exists(p) for p in edge_paths)
    if exe and os.path.exists(exe):
        r.ok("渲染用浏览器", "PLAYWRIGHT_EXECUTABLE_PATH → %s ✓" % exe)
    elif chan:
        if chan == "msedge" and has_edge:
            r.ok("渲染用浏览器", "PLAYWRIGHT_CHANNEL=msedge ✓（找到 Edge ✓）")
        elif chan == "chrome" and has_chrome:
            r.ok("渲染用浏览器", "PLAYWRIGHT_CHANNEL=chrome ✓")
        else:
            r.error(
                "渲染用浏览器",
                "**PLAYWRIGHT_CHANNEL=%s 找不到对应浏览器** ✗ —— 渲染不出 PDF ✗"
                "（这台机器上 Chrome=%s、Edge=%s ✓）" % (chan, has_chrome, has_edge),
            )
    elif has_chrome:
        r.ok("渲染用浏览器", "系统 Chrome ✓（默认走它 ✓）")
    elif has_edge:
        r.warn(
            "渲染用浏览器",
            "**只有 Edge，没有 Chrome** ✗ ⇒ `.env` 里加一行 `PLAYWRIGHT_CHANNEL=msedge` ✓"
            "（不配的话渲染会直接失败 ✗ ⇒ 出不了交付件 ✗）",
        )
    else:
        r.error("渲染用浏览器", "**既没有 Chrome 也没有 Edge** ✗ ⇒ 渲染不出 PDF ✗")

    # ── 9. 中文字体（系统里有没有）──────────────────────────────────
    fc = shutil.which("fc-list")
    if fc:
        try:
            out = subprocess.run(
                [fc, ":lang=zh"], capture_output=True, text=True, timeout=20
            ).stdout
            if out.strip():
                r.ok("系统中文字体", "%d 个 ✓" % len(out.strip().splitlines()))
            else:
                r.warn("系统中文字体", "**没找到中文字体** ✗ ⇒ 渲染可能出豆腐块 ✗")
        except Exception:
            r.warn("系统中文字体", "fc-list 跑不了（没装 fontconfig？）")
    else:
        r.warn("系统中文字体", "**没有 fc-list** ✗ ⇒ 没法查字体（容器里 fonts-noto-cjk 装了就有 ✓）")

    # ── 10. 深度冒烟 ────────────────────────────────────────────────
    if args.deep:
        if not pdfs:
            r.error("抽图冒烟", "没有源 PDF 可试 ✗")
        else:
            src = os.path.join(up, sorted(pdfs)[0])
            tmp = tempfile.mkdtemp(prefix="deploy-smoke-")
            try:
                p = subprocess.run(
                    [
                        sys.executable,
                        os.path.join(ROOT, "scripts", "extract_figures.py"),
                        "--pdf",
                        src,
                        "--out",
                        tmp,
                        "--pages",
                        "1",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if p.returncode == 0:
                    r.ok("抽图冒烟", "第 1 页抽图成功 ✓（fitz + 脚本可用 ✓）")
                    if has_ocr:
                        pngs = [f for f in os.listdir(tmp) if f.endswith(".png")]
                        if pngs:
                            try:
                                import easyocr

                                rd = easyocr.Reader(["ch_sim", "en"], gpu=False, verbose=False)
                                res = rd.readtext(os.path.join(tmp, sorted(pngs)[0]), detail=0, paragraph=True)
                                r.ok("OCR 冒烟", "读出 %d 处 ✓" % len(res or []))
                            except Exception as e:
                                r.warn("OCR 冒烟", "OCR 跑不起来：%s" % str(e)[:100])
                        else:
                            r.warn("OCR 冒烟", "第 1 页没抽出位图 ⇒ 没东西可 OCR（正常：那一页可能没图 ✓）")
                else:
                    r.error("抽图冒烟", "抽图脚本失败 ✗：%s" % (p.stderr or "")[-200:])
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

    # ── 输出 ────────────────────────────────────────────────────────
    if args.json:
        print(json.dumps({"ok": not r.errors, "items": r.items}, ensure_ascii=False, indent=1))
    else:
        print("\n部署自检（%s）\n" % ROOT)
        icon = {"ok": "  ✓", "warn": "  ⚠", "error": "  ✗"}
        for i in r.items:
            print("%s %s%s" % (icon[i["level"]], i["name"], ("  — " + i["detail"]) if i["detail"] else ""))
        print("")
        if r.errors:
            print("**有 %d 项阻断** ✗ —— 不修就出不了交付件 ✓" % len(r.errors))
        else:
            print("无阻断项 ✓" + ("（有 %d 项提醒 ✓ —— 对应能力降级 ✓）" % len(r.warns) if r.warns else ""))
        print("")
    return 1 if r.errors else 0


if __name__ == "__main__":
    sys.exit(main())
