#!/usr/bin/env python3
"""Check for tables with mismatched column counts."""
import os
import re

CHAPTERS_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\latex_output\chapters"

def read_utf8(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    return data.decode('utf-8')

def check_file(path):
    content = read_utf8(path)
    # Find all tables
    # Pattern: \begin{tabularx}{...}{...} or \begin{tabular}{...} ... \end{tabularx} or \end{tabular}
    pattern = re.compile(
        r'\\begin\{(tabularx?|longtable)\}\{([^}]*)\}\{([^}]*)\}(.*?)\\end\{(?:tabularx?|longtable)\}',
        re.DOTALL
    )

    issues = []
    for match in pattern.finditer(content):
        col_spec = match.group(3).strip()
        body = match.group(4)
        # Count columns in column spec
        expected_cols = 0
        for c in col_spec:
            if c in 'lcrXp{*}@':
                expected_cols += 1
        # Remove \multicolumn blocks first
        body_no_multi = re.sub(r'\\multicolumn\{(\d+)\}\{[^}]*\}\{[^}]*\}', r'\\multicolumn', body)
        # Process each row
        row_num = 0
        for line_match in re.finditer(r'([^\\\\]*?)(?:\\\\|$)', body_no_multi, re.DOTALL):
            row_num += 1
            row_content = line_match.group(1).strip()
            if not row_content or row_content.startswith('%'):
                continue
            if '\\hline' in row_content or '\\cline' in row_content:
                continue
            # Count & separators
            # Split on & but not inside math mode $...$
            parts = re.split(r'(\$[^$]*\$)', row_content)
            cell_count = 1  # start with 1 cell
            for part in parts:
                if part.startswith('$') and part.endswith('$'):
                    continue
                cell_count += part.count('&')
            if cell_count != expected_cols and cell_count != expected_cols + 1:
                # Sometimes \\hline can cause issues
                pass  # Skip for now, just track
            if cell_count > expected_cols:
                issues.append((row_num, expected_cols, cell_count, row_content[:80]))
    return issues

def main():
    files = sorted([f for f in os.listdir(CHAPTERS_DIR) if f.endswith('.tex')])
    total_issues = 0
    for f in files:
        path = os.path.join(CHAPTERS_DIR, f)
        issues = check_file(path)
        if issues:
            print(f"\n{f}: {len(issues)} issues")
            for issue in issues[:5]:
                print(f"  Row {issue[0]}: expected={issue[1]}, got={issue[2]}: {issue[3]}")
            total_issues += len(issues)
    print(f"\nTotal issues: {total_issues}")

if __name__ == '__main__':
    main()