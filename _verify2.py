"""Search for specific clauses in B and A to verify cited changes."""
import fitz, re

B = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"
A = r"C:\Users\zsndz\Desktop\comparison_agent-main\2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"

def search(doc, kw, max_hits=5):
    hits = []
    for i in range(len(doc)):
        txt = doc[i].get_text("text")
        if kw in txt:
            hits.append((i+1, txt.find(kw), txt[max(0, txt.find(kw)-50):txt.find(kw)+300]))
        if len(hits) >= max_hits:
            break
    return hits

print("\n========== Find 5.4.7.2 (倒车灯作为慢行灯) in B ==========")
doc = fitz.open(B)
for p, off, ctx in search(doc, "5.4.7.2"):
    print(f"\n--- B p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 5.4.7.2 in A ==========")
doc = fitz.open(A)
for p, off, ctx in search(doc, "5.21.7.2"):
    print(f"\n--- A p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 5.23.1 (紧急制动信号) in B ==========")
doc = fitz.open(B)
for p, off, ctx in search(doc, "5.23.1", 3):
    print(f"\n--- B p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 7.2.1 in A ==========")
doc = fitz.open(A)
for p, off, ctx in search(doc, "7.2.1", 3):
    print(f"\n--- A p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 5.24 (牵引杆挂车标志灯) in B ==========")
doc = fitz.open(B)
for p, off, ctx in search(doc, "5.24", 4):
    print(f"\n--- B p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 5.23 (牵引杆挂车标志灯 in 草案) in A ==========")
doc = fitz.open(A)
for p, off, ctx in search(doc, "5.23.4", 3):
    print(f"\n--- A p{p} ---")
    print(ctx)
doc.close()

print("\n========== Find 4.25 b (电压允差) in A 草案 ==========")
doc = fitz.open(A)
for p, off, ctx in search(doc, "13.5", 3):
    print(f"\n--- A p{p} ---")
    print(ctx)
doc.close()