"""按 max_tokens 梯度探测，确认 402 是否由预留输出额度触发。

MiniMax 账户的余额检查通常按「已用 + 预留(max_tokens)」估算。
13 章并发 × 8192 tokens 的预留总和可能超出账户可用额度。
"""
import json, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

KEY = sys.argv[1]
BASE = "https://api.minimax.cn/v1/text/chatcompletion_v2"
FILLER = "汽车外部照明装置安装条款示例文本。"


def call(max_tokens: int, i: int):
    body = FILLER * 200  # 约 2400 字符 prompt
    req = urllib.request.Request(
        BASE,
        data=json.dumps({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": body + f"\n第{i}次：请复述以上内容。"}],
            "max_tokens": max_tokens,
        }).encode("utf-8"),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return (i, r.status, f"{time.time()-t0:.1f}s", "ok")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(raw)
            et = (j.get("error") or {}).get("type", "?")
            msg = (j.get("error") or {}).get("message", "")[:60]
        except Exception:
            et, msg = "?", raw[:60]
        return (i, e.code, f"{time.time()-t0:.1f}s", f"{et}: {msg}")
    except Exception as e:
        return (i, "ERR", f"{time.time()-t0:.1f}s", f"{type(e).__name__}")


for mt, conc in [(64, 1), (8192, 1), (8192, 4), (8192, 8), (8192, 13)]:
    print(f"\n--- max_tokens={mt}, concurrency={conc} ---")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=conc) as ex:
        rs = list(ex.map(lambda i: call(mt, i), range(1, conc + 1)))
    ok = sum(1 for r in rs if r[1] == 200)
    for i, code, took, note in rs:
        print(f"  #{i:<3} HTTP {str(code):<5} {took:>7}  {note}")
    print(f"  => {ok}/{conc} ok in {time.time()-t0:.1f}s")
    if ok < conc:
        print("  >>> 触发失败，停止")
        break