#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fix LaTeX chapter files:
1. Read with proper UTF-8 encoding (with or without BOM)
2. Within tabular/tabularx blocks, replace cell separator `|` with `&`
3. Preserve `|` characters in column specifications
4. Write back as UTF-8 without BOM
"""

import os
import re
import sys

CHAPTERS_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\latex_output\chapters"

def read_utf8(path):
    """Read file as UTF-8, handling BOM if present."""
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):  # UTF-8 BOM
        data = data[3:]
    return data.decode('utf-8')

def write_utf8(path, content):
    """Write content as UTF-8 without BOM."""
    with open(path, 'wb') as f:
        f.write(content.encode('utf-8'))

def fix_table_blocks(content):
    """Within \\begin{tabular}...\\end{tabular} blocks, fix cell separators."""
    # Pattern to find tabular environments
    # Match: \begin{tabularx} or \begin{tabular} ... \end{tabularx} or \end{tabular}
    pattern = re.compile(
        r'(\\begin\{(?:tabularx?|longtable)\}.*?\\end\{(?:tabularx?|longtable)\})',
        re.DOTALL
    )

    def fix_block(match):
        block = match.group(0)
        # The header line has column spec like {|l|X|X|X|}
        # We don't want to change that
        # Process line by line
        lines = block.split('\n')
        new_lines = []
        for line in lines:
            stripped = line.strip()
            # Skip the \begin{...} and \end{...} lines and column spec lines
            if stripped.startswith('\\begin{') or stripped.startswith('\\end{'):
                new_lines.append(line)
                continue
            # Check if this line is inside the column specification (first line after \begin)
            # Column spec lines contain {|...|}
            if re.search(r'\{[\|lcrX]+\}', stripped) and '\\' not in stripped.split('&')[0]:
                # This is likely the column spec line
                new_lines.append(line)
                continue

            # This is a content line. Replace ` |` and ` |` patterns with `&`
            # Need to be careful: don't replace `|` in math expressions like $x \le |y|$
            # Split by $ to handle math mode
            parts = re.split(r'(\$[^$]*\$)', line)
            for i, part in enumerate(parts):
                if part.startswith('$') and part.endswith('$'):
                    # Math mode, leave alone
                    continue
                # Text mode - replace ` |` with `&`
                # In Chinese text there may not be space, use multiple patterns
                part = re.sub(r' \| ', ' & ', part)
                part = re.sub(r' +\| +', ' & ', part)
                part = re.sub(r'\|$', '&', part)
                part = re.sub(r'^\|', '&', part)
                parts[i] = part
            new_line = ''.join(parts)
            new_lines.append(new_line)
        return '\n'.join(new_lines)

    return pattern.sub(fix_block, content)

def process_file(path):
    """Process a single file."""
    content = read_utf8(path)
    new_content = fix_table_blocks(content)
    write_utf8(path, new_content)
    return True

def main():
    files = [f for f in os.listdir(CHAPTERS_DIR) if f.endswith('.tex')]
    for f in files:
        path = os.path.join(CHAPTERS_DIR, f)
        try:
            process_file(path)
            print(f"OK: {f}")
        except Exception as e:
            print(f"FAIL: {f}: {e}")

if __name__ == '__main__':
    main()