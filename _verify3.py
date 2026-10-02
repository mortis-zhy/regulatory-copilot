"""Find what clause numbers B actually uses for these topics."""
import fitz

B = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"
A = r"C:\Users\zsndz\Desktop\comparison_agent-main\2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"

print("\n========== In B: Find '倒车灯' ==========")
doc = fitz.open(B)
for i in range(len(doc)):
    txt = doc[i].get_text("text")
    if "倒车灯" in txt and "配备" in txt:
        print(f"\n--- B p{i+1} ---")
        idx = txt.find("倒车灯")
        print(txt[max(0, idx-100):idx+800])
        print("---")
doc.close()

print("\n\n========== In B: Find '紧急制动' ==========")
doc = fitz.open(B)
for i in range(len(doc)):
    txt = doc[i].get_text("text")
    if "紧急制动信号" in txt:
        print(f"\n--- B p{i+1} ---")
        idx = txt.find("紧急制动信号")
        print(txt[max(0, idx-100):idx+800])
        print("---")
doc.close()

print("\n\n========== In B: Find '牵引杆挂车' ==========")
doc = fitz.open(B)
for i in range(len(doc)):
    txt = doc[i].get_text("text")
    if "牵引杆挂车" in txt:
        print(f"\n--- B p{i+1} ---")
        idx = txt.find("牵引杆挂车")
        print(txt[max(0, idx-50):idx+500])
        print("---")
doc.close()

print("\n\n========== In A: Find ADS 标志灯 (C001) ==========")
doc = fitz.open(A)
for i in range(len(doc)):
    txt = doc[i].get_text("text")
    if "ADS" in txt and "标志" in txt:
        print(f"\n--- A p{i+1} ---")
        idx = txt.find("ADS")
        print(txt[max(0, idx-100):idx+500])
        print("---")
doc.close()