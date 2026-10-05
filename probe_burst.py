"""并发探测：确认 402 是否由并发触发，而非余额耗尽。

依次发 N 个并发请求，记录每个的 HTTP 状态与错误码。
"""
import json, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

KEY = sys.argv[1]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8
BASE = "https://api.minimax.cn/v1/text/chatcompletion_v2"


def call(i: int):
    req = urllib.request.Request(
        BASE,
        data=json.dumps({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": f"数到{i}，只回数字"}],
            "max_tokens": 24,
        }).encode("utf-8"),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return (i, r.status, f"{time.time()-t0:.1f}s", "ok")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code = ""
        try:
            j = json.loads(raw)
            code = (j.get("error") or {}).get("type", "?")
        except Exception:
            code = raw[:60]
        return (i, e.code, f"{time.time()-t0:.1f}s", code)
    except Exception as e:
        return (i, "ERR", f"{time.time()-t0:.1f}s", type(e).__name__)


print(f"firing {N} concurrent requests...\n")
t0 = time.time()
with ThreadPoolExecutor(max_workers=N) as ex:
    results = list(ex.map(call, range(1, N + 1)))

results.sort()
ok = sum(1 for r in results if r[1] == 200)
print(f"{'#':>3}  {'HTTP':>6}  {'took':>7}  result")
for i, code, took, note in results:
    print(f"{i:>3}  {str(code):>6}  {took:>7}  {note}")
print(f"\n{ok}/{len(results)} succeeded in {time.time()-t0:.1f}s")