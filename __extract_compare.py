"""Extract pages 106-115 from REF (key change-points chapter) and dump change-points from GEN."""
import fitz

REF = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
GEN_FINAL = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\final\回答PDF.pdf"

print("\n========== REF p106-115 (关键变化点总结 + 新增条款汇总 + 删除条款汇总 + 数据指标变化) ==========")
doc = fitz.open(REF)
for p in [105, 106, 107, 108, 109, 110, 111]:  # 0-indexed
    print(f"\n--- REF p{p+1} ---")
    print(doc[p].get_text("text")[:2500])
doc.close()

print("\n\n========== GEN_final: find pages containing change/new/delete keywords ==========")
doc = fitz.open(GEN_FINAL)
for i in range(len(doc)):
    txt = doc[i].get_text("text")
    if "变化" in txt or "新增" in txt or "删除" in txt:
        print(f"\n--- GEN p{i+1} ---")
        print(txt[:2500])
doc.close()