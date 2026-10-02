#!/usr/bin/env python3
"""Try to open password-protected PDFs with common passwords."""
import os
import sys

# PDF files to test
PDF_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main"
PDFS = [
    "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
]

# Common passwords to try
PASSWORDS = [
    "",  # Empty
    "password", "123456", "12345", "1234", "123",
    "GB4785", "GB 4785", "GB47852019", "GB4785-2019", "GB 4785-2019",
    "GB4785-2019", "GB4785.2019", "GB4785 2019",
    "GB4785draft", "GB4785V4.3.5", "GB4785V435",
    "UNR48", "UN-R48", "UNR4809", "UN-R48-09",
    "standards", "admin", "test", "0000",
    "GB", "2019", "V4.3.5", "draft",
    "2026", "2025", "automotive", "lighting",
    "regulations", "regulation",
]

def try_pdf(path, pwd):
    """Try to open PDF with given password."""
    try:
        import pikepdf
        try:
            with pikepdf.open(path, password=pwd) as pdf:
                return True
        except pikepdf.PasswordError:
            return False
    except Exception as e:
        return False

def main():
    results = {}
    for pdf_name in PDFS:
        path = os.path.join(PDF_DIR, pdf_name)
        if not os.path.exists(path):
            print(f"NOT FOUND: {pdf_name}")
            continue
        print(f"\nTesting: {pdf_name}")
        found_pwd = None
        for pwd in PASSWORDS:
            if try_pdf(path, pwd):
                print(f"  PASSWORD FOUND: '{pwd}'")
                found_pwd = pwd
                break
        if not found_pwd:
            print(f"  No password found in common list")
        results[pdf_name] = found_pwd

    print(f"\n{'='*60}")
    print("Summary:")
    for name, pwd in results.items():
        print(f"  {name}: password='{pwd}'")

if __name__ == '__main__':
    main()