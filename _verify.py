"""Verify specific changes cited in GEN_final against the actual original PDFs."""
import fitz

B = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"
A = r"C:\Users\zsndz\Desktop\comparison_agent-main\2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"

print("\n========== Verify C030 '删除 6V 系统电压限值' ==========")
print("\n--- B 2019 page 21 (clause 4.27 b) ---")
doc = fitz.open(B)
print(doc[20].get_text("text")[:1500])  # p21 = index 20
doc.close()

print("\n--- A 草案 page 16 (clause 4.25 b) ---")
doc = fitz.open(A)
print(doc[15].get_text("text")[:1500])  # p16 = index 15
doc.close()

print("\n========== Verify C011 '倒车灯作为慢行灯 10→15 km/h' ==========")
print("\n--- B 2019 page 25 (clause 5.4.7.2) ---")
doc = fitz.open(B)
for p in [24, 25]:
    print(f"\n--- p{p+1} ---")
    print(doc[p].get_text("text")[:1500])
doc.close()

print("\n--- A 草案 page 54 (clause 5.21.7.2) ---")
doc = fitz.open(A)
for p in [52, 53, 54]:
    print(f"\n--- p{p+1} ---")
    print(doc[p].get_text("text")[:1500])
doc.close()

print("\n========== Verify C034 '牵引杆挂车标志灯 高度 300-400 mm' ==========")
print("\n--- B 2019 page 55 (clause 5.24.4.2) ---")
doc = fitz.open(B)
print(doc[54].get_text("text")[:1500])
doc.close()

print("\n--- A 草案 page 56 (clause 5.23.4.2) ---")
doc = fitz.open(A)
print(doc[55].get_text("text")[:1500])
doc.close()

print("\n========== Verify C002 '紧急制动信号 选装→强制' ==========")
print("\n--- B 2019 page 53 (clause 5.23.1) ---")
doc = fitz.open(B)
print(doc[52].get_text("text")[:1500])
doc.close()

print("\n--- A 草案 page 64 (clause 7.2.1) ---")
doc = fitz.open(A)
print(doc[63].get_text("text")[:1500])
doc.close()