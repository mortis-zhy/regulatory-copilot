"""Dump GEN_final completely, look for 变化点 sections."""
import fitz
doc = fitz.open(r'C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\final\回答PDF.pdf')
print(f'Total pages: {len(doc)}')
for i in range(len(doc)):
    txt = doc[i].get_text('text')
    print(f'\n========== p{i+1} (len={len(txt)}) ==========')
    print(txt[:3500])
doc.close()