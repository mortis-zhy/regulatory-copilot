"""网站深度体检 — 遍历全站，找可改进点。

检查维度：
  A. 路由可达性      — 每个路由是否 200
  B. 控制台错误/警告  — 每个页面的 error / warn
  C. 交互完整性      — 按钮/链接是否可点、是否有死链
  D. 可访问性        — 缺 alt / label / heading 层级
  E. 边界情况        — 空数据 / 超长文本 / 404
  F. 性能            — 首屏渲染时间、资源数
  G. 响应式          — 375 / 768 / 1440 三档
"""
import json, sys, time, urllib.request, urllib.error
import websocket

PORT = sys.argv[1] if len(sys.argv) > 1 else "9333"
CDP = f"http://127.0.0.1:{PORT}"


def http(p):
    return json.load(urllib.request.urlopen(CDP + p, timeout=10))


tabs = http("/json/list")
target = next((t for t in tabs if t["type"] == "page"), None) or http("/json/new?http://localhost:3000/")
ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
_id = [0]
EVENTS = []


def send(method, params=None, wait=4):
    _id[0] += 1
    mid = _id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            ws.settimeout(max(0.2, deadline - time.time()))
            msg = json.loads(ws.recv())
        except Exception:
            continue
        if msg.get("id") == mid:
            return msg.get("result", {})
        EVENTS.append(msg)
    return {}


def drain():
    EVENTS.clear()


def collect_errors():
    errs, warns = [], []
    for e in EVENTS:
        if e.get("method") == "Log.entryAdded":
            lv = e["params"]["entry"]["level"]
            if lv == "error":
                errs.append(e["params"]["entry"]["text"][:160])
            elif lv == "warning":
                warns.append(e["params"]["entry"]["text"][:160])
        elif e.get("method") == "Runtime.exceptionThrown":
            d = e["params"]["exceptionDetails"]
            errs.append(f"未捕获: {d.get('text','')[:140]}")
        elif e.get("method") == "Runtime.consoleAPICalled" and e["params"].get("type") in ("error", "warning"):
            txt = " ".join(str(a.get("value", a.get("description", ""))) for a in e["params"].get("args", []))
            (errs if e["params"]["type"] == "error" else warns).append(txt[:160])
        elif e.get("method") == "Network.responseReceived":
            r = e["params"]["response"]
            if r["status"] >= 400:
                errs.append(f"HTTP {r['status']} {r['url'][:110]}")
    return errs, warns


def js(expr, wait=5):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True}, wait)
    try:
        return json.loads(r["result"]["value"])
    except Exception:
        return {}


send("Page.enable"); send("Runtime.enable"); send("Log.enable"); send("Network.enable")
send("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})

ROUTES = ["/", "/review", "/projects", "/documents", "/research", "/reports", "/settings", "/nope-404"]

print("=" * 92)
print("A+B. 路由可达性 + 控制台错误")
print("=" * 92)
route_report = []
for route in ROUTES:
    drain()
    t0 = time.time()
    send("Page.navigate", {"url": f"http://localhost:3000{route}"}, wait=5)
    time.sleep(2.2)
    ms = int((time.time() - t0) * 1000)
    info = js("""JSON.stringify({
      title: document.title,
      text: document.body.innerText.length,
      err: document.body.innerText.includes('404') || document.body.innerText.includes('Page Not Found'),
    })""")
    errs, warns = collect_errors()
    status = "✓" if info.get("text", 0) > 0 and not info.get("err") else "✗"
    route_report.append((route, status, ms, info, errs, warns))
    print(f"\n  {status} {route:14s} {ms:5d}ms  正文 {info.get('text',0):5d} 字符")
    if info.get("err"):
        print(f"      ⚠ 渲染了 404 页")
    for e in errs[:3]:
        print(f"      ERROR {e}")
    for w in warns[:2]:
        print(f"      WARN  {w}")

print("\n" + "=" * 92)
print("C+D. 交互完整性 + 可访问性（/review 与首页）")
print("=" * 92)
for route in ["/", "/review"]:
    send("Page.navigate", {"url": f"http://localhost:3000{route}"}, wait=5)
    time.sleep(2.2)
    audit = js("""JSON.stringify({
      btnTotal: document.querySelectorAll('button').length,
      btnNoLabel: Array.from(document.querySelectorAll('button')).filter(b=>!b.textContent?.trim() && !b.getAttribute('aria-label')).length,
      linkTotal: document.querySelectorAll('a').length,
      linkDead: Array.from(document.querySelectorAll('a')).filter(a=>a.getAttribute('href')==='#' || a.getAttribute('href')==='').length,
      imgNoAlt: document.querySelectorAll('img:not([alt])').length,
      inputNoLabel: Array.from(document.querySelectorAll('input,textarea,select')).filter(el=>{
        if (el.getAttribute('aria-label') || el.placeholder) return false;
        const id = el.getAttribute('id');
        return !(id && document.querySelector(`label[for="${id}"]`));
      }).length,
      h1: document.querySelectorAll('h1').length,
      langAttr: document.documentElement.getAttribute('lang'),
      title: document.title,
    })""")
    print(f"\n  {route}")
    for k, v in audit.items():
        flag = ""
        if k in ("btnNoLabel", "linkDead", "imgNoAlt", "inputNoLabel") and v > 0:
            flag = "  ⚠"
        print(f"    {k:16s} {v}{flag}")

print("\n" + "=" * 92)
print("G. 响应式（375 / 768 / 1440）")
print("=" * 92)
for w, label in [(375, "手机"), (768, "平板"), (1440, "桌面")]:
    send("Emulation.setDeviceMetricsOverride", {"width": w, "height": 900, "deviceScaleFactor": 1, "mobile": w < 768})
    send("Page.navigate", {"url": "http://localhost:3000/review"}, wait=5)
    time.sleep(2.2)
    m = js("""JSON.stringify({
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      scrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    })""")
    bad = "⚠ 横向溢出" if m.get("overflowX") else "✓ 无溢出"
    print(f"  {label:4s} {w:5d}px  {bad}  (scrollW={m.get('scrollW')} winW={m.get('winW')})")

send("Emulation.clearDeviceMetricsOverride")
ws.close()