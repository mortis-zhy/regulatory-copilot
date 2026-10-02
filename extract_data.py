#!/usr/bin/env python3
"""Extract structured data from extracted PDF text files."""
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

# Read all files
contents = {}
for key, fname in FILES.items():
    contents[key] = read_file(fname)

# Output key sections found
print("="*80)
print("GB 4785-2019 - 5.x Section Numbers Found")
print("="*80)
text = contents["current"]
sections = re.findall(r'(?<!\.)5\.\d+(?:\.\d+)*', text)
unique_sections = sorted(set(sections))
print(f"Unique 5.x sections: {len(unique_sections)}")
print(f"Sections: {unique_sections[:50]}")

print("\n" + "="*80)
print("GB 4785 草案 V4.3.5 - 5.x Section Numbers Found")
print("="*80)
text = contents["draft"]
sections = re.findall(r'(?<!\.)5\.\d+(?:\.\d+)*', text)
unique_sections = sorted(set(sections))
print(f"Unique 5.x sections: {len(unique_sections)}")
print(f"Sections: {unique_sections[:50]}")

print("\n" + "="*80)
print("UN R48-09 - 6.x Section Numbers Found")
print("="*80)
text = contents["unece"]
sections = re.findall(r'(?<!\.)6\.\d+(?:\.\d+)*', text)
unique_sections = sorted(set(sections))
print(f"Unique 6.x sections: {len(unique_sections)}")
print(f"Sections: {unique_sections[:50]}")

# Extract specific numerical values
print("\n" + "="*80)
print("EXTRACTING SPECIFIC VALUES")
print("="*80)

all_data = {}
for key, fname in FILES.items():
    text = contents[key]
    mm_values = re.findall(r'\d+\s*(?:mm|㎜)', text)
    cd_values = re.findall(r'\d+\s*(?:cd|坎德拉)', text)
    hz_values = re.findall(r'\d+(?:\.\d+)?\s*Hz', text)
    percent_values = re.findall(r'-?\d+(?:\.\d+)?\s*%', text)
    lx_values = re.findall(r'\d+\s*lx', text)
    all_data[key] = {
        "mm_count": len(mm_values),
        "cd_count": len(cd_values),
        "hz_count": len(hz_values),
        "percent_count": len(percent_values),
        "lx_count": len(lx_values),
        "sample_mm": mm_values[:20],
        "sample_hz": hz_values[:10],
        "sample_percent": percent_values[:15],
        "sample_lx": lx_values[:10],
    }
    print(f"\n{key}:")
    for k, v in all_data[key].items():
        print(f"  {k}: {v}")

# Save data summary
with open(os.path.join(EXTRACT_DIR, "data_summary.json"), 'w', encoding='utf-8') as f:
    json.dump(all_data, f, ensure_ascii=False, indent=2)
print("\n✓ Data summary saved to data_summary.json")