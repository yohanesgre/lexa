#!/usr/bin/env bash
# Build wireframes: recursively resolve <INCLUDE partials/FILE> from src/ → dist/.
# Supports nested includes — partials can include other partials.
# Handles both line-start and inline (mid-tag) INCLUDEs.
set -euo pipefail
cd "$(dirname "$0")"

MAX_DEPTH=10
PARTIALS_DIR="src/partials"

rm -rf dist
mkdir -p dist
cp src/wireframes.css dist/

python3 - "$PARTIALS_DIR" "$MAX_DEPTH" << 'PYEOF'
import sys, re, os

partials_dir = sys.argv[1]
max_depth = int(sys.argv[2])

def resolve(filepath, depth=0):
    if depth > max_depth:
        return f"<!-- MAX_DEPTH exceeded for {filepath} -->"
    with open(filepath) as f:
        content = f.read()
    def repl(m):
        indent = m.group(1)
        name = m.group(2)
        p = os.path.join(partials_dir, name)
        if os.path.isfile(p):
            inner = resolve(p, depth + 1)
            return "\n".join(indent + line for line in inner.split("\n"))
        return f"{indent}<!-- MISSING: {p} -->"
    # Match <INCLUDE name.html /> at line start (with optional indent) or inline
    content = re.sub(r'^(\s*)<INCLUDE (\S+) />', repl, content, flags=re.MULTILINE)
    content = re.sub(r'<INCLUDE (\S+) />', lambda m: resolve(os.path.join(partials_dir, m.group(1)), depth + 1).strip(), content)
    return content

src_dir = "src"
for f in sorted(os.listdir(src_dir)):
    if not f.endswith(".html"):
        continue
    src = os.path.join(src_dir, f)
    out = os.path.join("dist", f)
    result = resolve(src)
    with open(out, "w") as fh:
        fh.write(result)
    print(f"  built {f}")
print("Done.")
PYEOF
