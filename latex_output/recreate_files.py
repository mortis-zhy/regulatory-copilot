#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Rewrite all chapter files with proper UTF-8 encoding, fixing table separators.
This script will:
1. Read each file as UTF-8
2. Fix any obvious issues
3. Write back as UTF-8 without BOM

Actually, this script just verifies the files are readable as UTF-8 and
counts braces to detect issues.
"""

import os
import sys
import re

CHAPTERS_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\latex_output\chapters"

def read_utf8(path):
    """Read file as UTF-8, handling BOM if present."""
    with open(path, 'rb') as f:
        data = f.read()
    if data.startswith(b'\xef\xbb\xbf'):  # UTF-8 BOM
        data = data[3:]
    return data.decode('utf-8')

def main():
    files = sorted([f for f in os.listdir(CHAPTERS_DIR) if f.endswith('.tex')])
    print("File analysis:")
    print("=" * 70)
    for f in files:
        path = os.path.join(CHAPTERS_DIR, f)
        try:
            content = read_utf8(path)
            nlines = content.count('\n')
            open_b = content.count('{')
            close_b = content.count('}')
            print(f"{f}: {nlines:4d} lines, open={open_b:3d}, close={close_b:3d}, diff={open_b - close_b:+d}")
        except Exception as e:
            print(f"{f}: ERROR - {e}")

if __name__ == '__main__':
    main()