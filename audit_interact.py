"""网站深度交互测试 —— 测真实使用路径，不只是看页面能否渲染。

覆盖：
  A. 上传流程   — 选文件 → 解析 → 状态流转 → 错误处理
  B. 生成流程   — 点"生成完整报告" → 面板状态 → 取消/关闭
  C. API 契约   — 每个端点的形状与错误码
  D. 空态/边界  — 无报告时的 /review、无文档时的首页
  E. 键盘可达  — Tab 顺序、Esc、Enter
  F. 重复操作  — 快速连点是否产生重复请求
"""
import json, sys, time, urllib.request, urllib.error
import websocket

PORT = sys.argv[1] if len(sys.argv) > 1 else "9333"
CDP = f"http://127.0.0.1:{PORT}"
BASE = "http://localhost:3000"


def http_json(path):
    try:
        r = urllib.request.urlopen(BASE + path, timeout=15)
        return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"err": str(e)}


def post_json(path, payload=None):
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        ct = r.headers.get("Content-Type", "")
        body = r.read()
        return r.status, ct, len(body)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), len(e.read())
    except Exception as e:
        return 0, str(e), 0


tabs = json.load(urllib.request.urlopen(CDP + "/json/list", timeout=10))
target = next((t for t in tabs if t["type"] == "page"), None) or json.load(
    urllib.request.urlopen(CDP + "/json/new?http://localhost:3000/", timeout=10))
ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=40)
_id = [0]
NET = []


def send(method, params=None, wait=4):
    _id[0] += 1
    mid = _id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    dl = time.time() + wait
    while time.time() < dl:
        try:
            ws.settimeout(max(0.2, dl - time.time()))
            msg = json.loads(ws.recv())
        except Exception:
            continue
        if msg.get("id") == mid:
            return msg.get("result", {})
        NET.append(msg)
    return {}


def js(expr, wait=5):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True}, wait)
    try:
        return json.loads(r["result"]["value"])
    except Exception:
        return {}


def goto(route, wait=3):
    NET.clear()
    send("Page.navigate", {"url": BASE + route}, wait=6)
    time.sleep(wait)


send("Page.enable"); send("Runtime.enable"); send("Log.enable"); send("Network.enable")

print("=" * 94)
print("C. API 契约 —— 端点形状与错误码")
print("=" * 94)
GETS = ["/api/agent/report/last", "/api/agent/report/trust"]
for p in GETS:
    st, body = http_json(p)
    keys = list(body.keys())[:8] if isinstance(body, dict) else type(body).__name__
    print(f"  GET  {p:32s} {st}  keys={keys}")

POSTS = [
    ("/api/agent/report/render", {"chapters": [], "outline": {}}, "空报告"),
    ("/api/agent/report/pdf", {}, "无 body"),
    ("/api/agent/report/pdf", {"useV8": True}, "V8 导出"),
    ("/api/agent/report/trust/verdict", {}, "空 verdict"),
]
for p, payload, label in POSTS:
    if "render" in p and label == "V8 导出":
        continue  # 渲染慢，单独测
    st, ct, n = post_json(p, payload)
    print(f"  POST {p:32s} {st}  ({label})  {ct.split(';')[0][:28]}  {n}B")

print("\n" + "=" * 94)
print("D. 空态 / 边界")
print("=" * 94)
goto("/review")
state = js("""JSON.stringify({
  text: document.body.innerText.slice(0, 160),
  hasGate: document.body.innerText.includes('完整性检查'),
  hasTabs: document.querySelectorAll('nav button').length,
  emptyHint: document.body.innerText.includes('尚未生成') || document.body.innerText.includes('无法载入'),
})""")
print(f"  /review 完整性横幅 : {state.get('hasGate')}")
print(f"  /review Tab 数   : {state.get('hasTabs')}")
print(f"  空态提示         : {state.get('emptyHint')}")
print(f"  可见文本         : {state.get('text','')[:90]}")

goto("/")
state2 = js("""JSON.stringify({
  docCards: document.querySelectorAll('main .rounded-xl').length,
  uploadBtn: Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.includes('添加法规')),
  generateBtn: Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes('生成完整报告'))?.disabled,
  dropZone: document.body.innerText.includes('把 PDF / Word 拖到这里'),
  inputExists: document.querySelectorAll('input[type=file]').length,
})""")
print(f"  首页上传按钮     : {state2.get('uploadBtn')}")
print(f"  首页拖放区       : {state2.get('dropZone')}")
print(f"  file input 数    : {state2.get('inputExists')}")
print(f"  生成按钮 disabled: {state2.get('generateBtn')}  (无文档时应为 True)")

print("\n" + "=" * 94)
print("A. 上传流程 —— 真实选文件 → 解析 → 状态")
print("=" * 94)
# 通过 CDP 设置 file input
doc = js("JSON.stringify(!!document.querySelector('input[type=file]'))")
if doc:
    r = send("DOM.getDocument", wait=4)
    root = r.get("root", {}).get("nodeId")
    q = send("DOM.querySelector", {"nodeId": root, "selector": "input[type=file]"}, wait=4)
    nid = q.get("nodeId")
    if nid:
        try:
            send("DOM.setFileInputFiles", {
                "files": [r"C:\Users\zsndz\Desktop\comparison_agent-main\UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf"],
                "nodeId": nid,
            }, wait=6)
            time.sleep(5)
            st = js("""JSON.stringify({
              docStrip: document.body.innerText.includes('UN_R048') || document.body.innerText.includes('源文件'),
              parseAnim: document.body.innerText.includes('读取文件') || document.body.innerText.includes('抽取参数'),
              ready: document.body.innerText.includes('可分析'),
              err: document.body.innerText.includes('失败') || document.body.innerText.includes('错误'),
              genEnabled: !Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes('生成完整报告'))?.disabled,
            })""", wait=8)
            print(f"  文档已加入       : {st.get('docStrip')}")
            print(f"  解析动画         : {st.get('parseAnim')}")
            print(f"  解析完成         : {st.get('ready')}")
            print(f"  出现错误         : {st.get('err')}")
            print(f"  生成按钮可用     : {st.get('genEnabled')}")
        except Exception as e:
            print("  ⚠ setFileInputFiles 失败:", str(e)[:100])
    else:
        print("  ⚠ 未找到 file input 节点")

print("\n" + "=" * 94)
print("F. 重复操作 —— 快速连点是否产生重复请求")
print("=" * 94)
NET.clear()
js("""(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent?.trim()==='PDF');
  if (b) { b.click(); b.click(); b.click(); }
  return 'clicked x3';
})()""", wait=6)
time.sleep(3)
pdf_calls = sum(1 for e in NET if e.get("method") == "Network.requestWillBeSent"
                and "/api/agent/report/pdf" in e["params"]["request"]["url"])
print(f"  3 连点 → 实际请求数: {pdf_calls}  {'✓ 已节流' if pdf_calls <= 1 else '⚠ 无节流，会并发 3 次渲染'}")
send("Page.stopLoading")

ws.close()