"""CDP 实测：点击界面 PDF 按钮 → 捕获真实下载 → 校验产物。"""
import json, sys, time, urllib.request, os
import websocket

PORT = sys.argv[1] if len(sys.argv) > 1 else "9333"
CDP = f"http://127.0.0.1:{PORT}"
DL = os.path.abspath("chrome_downloads")
os.makedirs(DL, exist_ok=True)


def http(p):
    return json.load(urllib.request.urlopen(CDP + p, timeout=10))


tabs = http("/json/list")
target = next((t for t in tabs if t["type"] == "page" and "localhost:3000" in t.get("url", "")), None) \
    or http("/json/new?http://localhost:3000/")

ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
_id = [0]


def send(method, params=None, wait=3):
    _id[0] += 1
    mid = _id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + wait
    evs = []
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.2, deadline - time.time()))
            msg = json.loads(ws.recv())
        except Exception:
            continue
        if msg.get("id") == mid:
            return msg.get("result", {}), evs
        evs.append(msg)
    return {}, evs


send("Page.enable"); send("Runtime.enable"); send("Network.enable")
send("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": DL})

print("=" * 70)
print("PDF 按钮端到端实测（真实浏览器点击）")
print("=" * 70)

send("Page.navigate", {"url": "http://localhost:3000/"}, wait=6)
time.sleep(4)

# 记录点击前
before = set(os.listdir(DL))
res, _ = send("Runtime.evaluate", {
    "expression": """(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => x.textContent?.trim() === 'PDF');
      if (!b) return 'button not found';
      if (b.disabled) return 'button disabled';
      b.click();
      return 'clicked';
    })()""",
    "returnByValue": True,
}, wait=5)
print("  点击结果:", res.get("result", {}).get("value"))

# V8 渲染 ~60 秒
print("  等待渲染（约 60 秒）…")
deadline = time.time() + 180
got = None
while time.time() < deadline:
    time.sleep(4)
    new = set(os.listdir(DL)) - before
    done = [f for f in new if f.endswith(".pdf") and not f.endswith(".crdownload")]
    if done:
        got = done[0]
        break
    inprogress = [f for f in new if f.endswith(".crdownload")]
    if inprogress:
        print("   下载中…", inprogress[0][:50])

if not got:
    print("  ✗ 180 秒内未捕获到下载文件")
    print("  目录内容:", os.listdir(DL))
else:
    path = os.path.join(DL, got)
    size = os.path.getsize(path)
    print(f"  ✓ 下载完成: {got}")
    print(f"    大小: {size:,} 字节 ({size/1024/1024:.2f} MB)")
    # 校验 PDF 页数
    try:
        import fitz
        d = fitz.open(path)
        print(f"    页数: {len(d)}")
        txt = "".join(p.get_text() for p in d)
        for kw in ["符号说明", "候选差异闭环统计", "待复核明细清单", "一致性自查",
                   "过渡期生效汇总表", "术语对照"]:
            print(f"    含「{kw}」:", "✓" if kw in txt else "✗")
        d.close()
    except Exception as e:
        print("    页数校验失败:", e)

ws.close()
