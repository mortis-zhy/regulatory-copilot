"""Byte-level fix: replace any NUL-padded CODE sentinel with ASCII ~~CODEBLOCK~~."""
import re
import sys

path = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\client\src\pages\Home.tsx"
data = open(path, "rb").read()

# 1) The masked return:  return `...CODE${blocks.length - 1}...`;
#    could be: ` CODE${...} ` (spaces) or `\x00CODE${...}\x00` (NULs)
pattern1 = re.compile(rb"return `[^\`]*CODE\$\{blocks\.length - 1\}[^\`]*`;")
new1 = b"return `~~CODEBLOCK${blocks.length - 1}~~`;"
data, n1 = pattern1.subn(new1, data)

# 2) The restore regex:  / CODE(\d+) /g  or  /\x00CODE(\d+)\x00/g
pattern2 = re.compile(rb"collapsed\.replace\(/[^/]*/g")
# find the full statement line containing "blocks[Number(i)]" to be safe
lines = data.split(b"\n")
out = []
replaced = False
for ln in lines:
    if b"blocks[Number(i)]" in ln and b"collapsed.replace" in ln:
        out.append(b"  return collapsed.replace(/~~CODEBLOCK(\\d+)~~/g, (m, i) => blocks[Number(i)] ?? m);")
        replaced = True
    else:
        out.append(ln)
data = b"\n".join(out)

# 3) Safety: strip any raw NUL bytes anywhere else (they'd break esbuild)
nul_count = data.count(b"\x00")
data = data.replace(b"\x00", b"")

open(path, "wb").write(data)
print(f"masked-return replaced: {n1}")
print(f"restore-line replaced: {replaced}")
print(f"NUL bytes removed: {nul_count}")
