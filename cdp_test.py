"""用 Chrome DevTools Protocol (CDP) 实测网站。

MCP 工具本会话不可用，但 Chrome 已在 9222 端口开调试模式，直接走 CDP
（等价于 MCP 底层做的事：导航、取 DOM、抓 console、网络监听）。
"""
import json
import time
import urllib.request
import websocket  # websocket-client

import sys
PORT = sys.argv[1] if len(sys.argv)>1 else "9333"
CDP = f"http://127.0.0.1:{PORT}"


def http(path):
    return json.load(urllib.request.urlopen(CDP + path, timeout=10))


# 找或开一个标签页
tabs = http("/json/list")
target = None
for t in tabs:
    if t["type"] == "page" and "localhost:3000" in t.get("url", ""):
        target = t
        break
if not target:
    target = http("/json/new?http://localhost:3000/")

ws_url = target["webSocketDebuggerUrl"]
ws = websocket.create_connection(ws_url, timeout=30)
_id = [0]


def send(method, params=None, wait=3):
    _id[0] += 1
    mid = _id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + wait
    events = []
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.2, deadline - time.time()))
            msg = json.loads(ws.recv())
        except Exception:
            continue
        if msg.get("id") == mid:
            return msg.get("result", {}), events
        events.append(msg)
    return {}, events


send("Page.enable")
send("Runtime.enable")
send("Log.enable")
send("Network.enable")

print("=" * 70)
print("① 首页")
print("=" * 70)
send("Page.navigate", {"url": "http://localhost:3000/"}, wait=5)
time.sleep(4)
res, evs = send("Runtime.evaluate", {
    "expression": "JSON.stringify({title: document.title, h1: document.querySelector('h1')?.textContent?.slice(0,60) ?? null, main: document.querySelector('main')?.innerText?.slice(0,80) ?? null, buttons: Array.from(document.querySelectorAll('button')).map(b=>b.textContent?.trim()).filter(Boolean).slice(0,12)})",
    "returnByValue": True,
}, wait=5)
info = json.loads(res["result"]["value"])
if "h1" not in info: info["h1"] = info.get("main")
print("  title  :", info["title"])
print("  h1     :", info["h1"])
print("  按钮   :", info["buttons"])

errs = [e for e in evs if e.get("method") == "Log.entryAdded"
        and e["params"]["entry"]["level"] in ("error",)]
console_err = [e for e in evs if e.get("method") == "Runtime.exceptionThrown"]
print(f"  console error: {len(errs)} | 未捕获异常: {len(console_err)}")
for e in errs[:5]:
    print("    !", e["params"]["entry"]["text"][:120])

print()
print("=" * 70)
print("② /review 审阅工作台")
print("=" * 70)
send("Page.navigate", {"url": "http://localhost:3000/review"}, wait=5)
time.sleep(4)
res, _ = send("Runtime.evaluate", {
    "expression": """JSON.stringify({
      h1: document.querySelector('h1')?.textContent?.slice(0,40),
      tabs: Array.from(document.querySelectorAll('nav button')).map(b=>b.textContent?.trim().slice(0,20)),
      gate: document.body.innerText.includes('完整性检查通过') || document.body.innerText.includes('完整性检查未通过'),
      hasRows: document.querySelectorAll('tbody tr').length,
      worklist: document.body.innerText.includes('待复核明细清单'),
    })""",
    "returnByValue": True,
}, wait=5)
rv = json.loads(res["result"]["value"])
print("  标题   :", rv["h1"])
print("  Tab    :", rv["tabs"])
print("  完整性横幅:", "✅ 有" if rv["gate"] else "❌ 无")
print("  表格行数:", rv["hasRows"])
print("  待复核明细:", "✅ 有" if rv["worklist"] else "❌ 无")

# 点开假差异工作台
res, _ = send("Runtime.evaluate", {
    "expression": """(() => {
      const b = Array.from(document.querySelectorAll('nav button')).find(x => x.textContent?.includes('假差异工作台'));
      if (b) { b.click(); return 'clicked'; }
      return 'not found';
    })()""",
    "returnByValue": True,
}, wait=5)
print("  点击假差异 Tab:", res["result"]["value"])
time.sleep(2)
res, _ = send("Runtime.evaluate", {
    "expression": "JSON.stringify({rows: document.querySelectorAll('tbody tr').length, text: document.body.innerText.slice(0,80)})",
    "returnByValue": True,
}, wait=5)
print("  展开后行数:", json.loads(res["result"]["value"])["rows"])

ws.close()
print()
print("MCP 工具本会话不可用，已用等效的 CDP 直连完成实测。")
