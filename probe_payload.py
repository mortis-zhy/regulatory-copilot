"""按 prompt 体量梯度测试，找出触发 402 的阈值。

生成时每章 prompt: docs=170088~463771 chars + regex=20494~59672 chars。
先用小请求确认通路，再逐级放大。
"""
import json, sys, time, urllib.request, urllib.error

KEY = sys.argv[1]
BASE = "https://api.minimax.cn/v1/text/chatcompletion_v2"

FILLER = "汽车及挂车外部照明和光信号装置安装的规定条款内容示例文本。"


def probe(chars: int, label: str):
    # 造一个约 chars 长度的 prompt
    repeats = max(1, chars // len(FILLER))
    body_text = FILLER * repeats
    payload = {
        "model": "MiniMax-M3",
        "messages": [{
            "role": "user",
            "content": f"以下是一份法规节选（{label}）：\n\n{body_text}\n\n请用一句话概括这份法规的适用范围。",
        }],
        "max_tokens": 64,
    }
    raw = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE, data=raw,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read().decode("utf-8"))
            usage = j.get("usage", {})
            return (label, len(raw) // 1024, r.status,
                    f"{time.time()-t0:.1f}s",
                    f"prompt_tokens={usage.get('total_tokens', '?')}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(body)
            msg = (j.get("error") or {}).get("message", body[:80])
            etype = (j.get("error") or {}).get("type", "?")
        except Exception:
            msg, etype = body[:80], "?"
        return (label, len(raw) // 1024, e.code, f"{time.time()-t0:.1f}s", f"{etype}: {msg[:70]}")
    except Exception as e:
        return (label, len(raw) // 1024, "ERR", f"{time.time()-t0:.1f}s", f"{type(e).__name__}: {str(e)[:60]}")


sizes = [("1K", 1_000), ("50K", 50_000), ("200K", 200_000), ("500K", 500_000)]
print(f"{'label':>7} {'reqKB':>7} {'HTTP':>6} {'took':>7}  detail")
print("-" * 84)
for label, n in sizes:
    r = probe(n, label)
    print(f"{r[0]:>7} {r[1]:>7} {str(r[2]):>6} {r[3]:>7}  {r[4]}")
    if r[2] != 200:
        print(f"\n>>> 在 {label} 处失败，停止探测")
        break