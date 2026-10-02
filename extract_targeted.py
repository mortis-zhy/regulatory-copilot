#!/usr/bin/env python3
"""Extract specific values from extracted text files for each clause."""
import re
import os
import json

EXTRACT_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\extracted"

FILES = {
    "current": "current_full.txt",  # GB 4785-2019
    "draft": "draft_full.txt",      # 草案 V4.3.5
    "unece": "unece_full.txt",       # UN R48-09
}

def read_file(name):
    path = os.path.join(EXTRACT_DIR, name)
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    return data.decode('utf-8')

contents = {k: read_file(v) for k, v in FILES.items()}

# Extract specific clause-by-clause data
print("="*80)
print("EXTRACTING SPECIFIC CLAUSES (Current GB 4785-2019)")
print("="*80)

# 5.1.9.1 远光灯最大光强之和
text = contents["current"]
matches = re.findall(r'5\.\s*1\.\s*9\.\s*1[^\n]*\n[^\n]*', text)
print(f"5.1.9.1 context: {matches[:1]}")

# 5.5.4.2 转向灯高度
matches = re.findall(r'5\.\s*5\.\s*4\.\s*2[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"5.5.4.2 context: {matches[:1]}")

# 5.19.7.1 昼间行驶灯电路连接
matches = re.findall(r'5\.\s*19\.\s*7\.\s*1[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"5.19.7.1 context: {matches[:1]}")

# 5.7 制动灯
matches = re.findall(r'5\.\s*7\.\s*4\.\s*2\.\s*1[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"5.7.4.2.1 context: {matches[:1]}")

print("\n" + "="*80)
print("EXTRACTING SPECIFIC CLAUSES (Draft V4.3.5)")
print("="*80)
text = contents["draft"]
# 5.7 制动灯
matches = re.findall(r'5\.\s*7\.\s*7\.\s*2[^\n]*\n[^\n]*', text)
print(f"5.7.7 context: {matches[:2]}")

# 5.24 ADS标志灯
matches = re.findall(r'5\.\s*24\.\s*5[^\n]*\n[^\n]*', text)
print(f"5.24.5 context: {matches[:1]}")

# 6.4 发光徽标
matches = re.findall(r'6\.\s*4\.\s*2\.\s*4[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.4.2.4 context: {matches[:1]}")

# 6.2 光信号投射功能
matches = re.findall(r'6\.\s*2\.\s*2\.\s*3[^\n]*\n[^\n]*', text)
print(f"6.2.2.3 context: {matches[:1]}")

# 7.2 紧急制动信号
matches = re.findall(r'7\.\s*2\.\s*7[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"7.2.7 context: {matches[:1]}")

# 7.3 RECAS
matches = re.findall(r'7\.\s*3\.\s*7[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"7.3.7 context: {matches[:1]}")

print("\n" + "="*80)
print("EXTRACTING SPECIFIC CLAUSES (UN R48-09)")
print("="*80)
text = contents["unece"]
# 6.2.6 下倾度
matches = re.findall(r'6\.\s*2\.\s*6\.\s*1\.\s*2[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.2.6.1.2 context: {matches[:1]}")

# 6.1.9.3.1.2 探测距离
matches = re.findall(r'6\.\s*1\.\s*9\.\s*3\.\s*1\.\s*2[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.1.9.3.1.2 context: {matches[:1]}")

# 6.1.9.3.5 自动熄灭
matches = re.findall(r'6\.\s*1\.\s*9\.\s*3\.\s*5[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.1.9.3.5 context: {matches[:1]}")

# 6.5 转向信号灯 高度
matches = re.findall(r'6\.\s*5\.\s*4\.\s*2[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.5.4.2 context: {matches[:1]}")

# 6.7 制动灯高度
matches = re.findall(r'6\.\s*7\.\s*4\.\s*2\.\s*1[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.7.4.2.1 context: {matches[:1]}")

# 6.11 后雾灯
matches = re.findall(r'6\.\s*11\.\s*4\.\s*2[^\n]*\n[^\n]*', text)
print(f"6.11.4.2 context: {matches[:1]}")

# 6.20 角灯
matches = re.findall(r'6\.\s*20\.\s*4\.\s*2[^\n]*\n[^\n]*', text)
print(f"6.20.4.2 context: {matches[:1]}")

# 6.20.4.3 高度
matches = re.findall(r'6\.\s*20\.\s*4\.\s*3[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.20.4.3 context: {matches[:1]}")

# 6.27 RECAS or similar
matches = re.findall(r'6\.\s*27[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"6.27 context: {matches[:1]}")

# Search for "rear-end collision alert signal" or "RECAS"
matches = re.findall(r'[Rr]ear-end [Cc]ollision [Aa]lert[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"RECAS: {matches[:3]}")

# Search for "courtesy lamp"
matches = re.findall(r'[Cc]ourtesy lamp[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"courtesy: {matches[:3]}")

# Search for "manoeuvring lamp"
matches = re.findall(r'[Mm]anoeuvring lamp[^\n]*\n[^\n]*\n[^\n]*', text)
print(f"manoeuvring: {matches[:3]}")

# Search for ADB in UN R48
matches = re.findall(r'[Aa]daptive [Dd]riving [Bb]eam[^\n]*', text)
print(f"ADB UN R48: {matches[:5]}")