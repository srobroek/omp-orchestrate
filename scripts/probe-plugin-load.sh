#!/bin/sh
# Deterministic packaging oracle: did OMP import and invoke THIS entry point?
#
# Run it whenever `omp.extensions` or the build changes. Always run a baseline branch
# too: an oracle that cannot detect a working load proves nothing, and two earlier
# attempts at this used needles absent from transcripts by design, so both reported
# failure against a branch that worked.
#
# No model output, no transcript archaeology. The clone's own extension factory writes a
# unique marker as its first statement, so the marker exists if and only if OMP resolved
# the manifest, imported that exact file, and called its default export. A failed model
# call cannot hide it, because factories run during session init.
#
# Usage: sh scripts/probe-plugin-load.sh <branch> <tag>
#
#   sh scripts/probe-plugin-load.sh main baseline
#   sh scripts/probe-plugin-load.sh my/branch candidate
set -eu

BRANCH=$1
TAG=$2
CLONE=/tmp/orc-$TAG-clone
PROJ=/tmp/orc-$TAG-proj
MARKER=/tmp/orc-$TAG-marker

rm -rf "$CLONE" "$PROJ" "$MARKER"
git clone -q --branch "$BRANCH" --single-branch "$HOME/personal/dev/omp-orchestrate" "$CLONE"

printf 'branch=%-28s dist=%-4s entry=%s\n' \
	"$BRANCH" \
	"$([ -d "$CLONE/dist" ] && echo YES || echo no)" \
	"$(python3 -c "import json;print(json.load(open('$CLONE/package.json'))['omp']['extensions'][0])")"

# Instrument the factory in the clone only. The parent repository is never touched.
python3 - "$CLONE" "$MARKER" <<'PY'
import pathlib, re, sys
clone, marker = sys.argv[1], sys.argv[2]
src = pathlib.Path(clone) / "src" / "index.ts"
text = src.read_text()
m = re.search(r"^export default function [A-Za-z_]+\([^)]*\)[^\{]*\{", text, re.M)
if not m:
    raise SystemExit("could not find the default factory in src/index.ts")
inject = f'\n\trequire("node:fs").writeFileSync({marker!r}, "invoked");'
src.write_text(text[: m.end()] + inject + text[m.end() :])
print("instrumented:", src)
PY

# The entry OMP loads must be the instrumented one. On main that is the bundle, so it is
# rebuilt from the instrumented source; on the source branch there is nothing to build.
if [ -d "$CLONE/dist" ]; then
	(cd "$CLONE" && bun install --silent >/dev/null 2>&1 || true; cd "$CLONE" && bun run build >/dev/null 2>&1) || {
		echo "FAIL: could not rebuild the instrumented bundle"
		exit 1
	}
	echo "rebuilt the bundle from instrumented source"
fi

mkdir -p "$PROJ"
cd "$PROJ"
git init -q -b main
git config user.email probe@test.local
git config user.name Probe

omp plugin link "$CLONE" --scope project >/dev/null 2>&1 || true
echo "link resolves: $(omp plugin list 2>/dev/null | grep -c 'omp-orchestrate' || echo 0)"

SHELL=/bin/sh omp -p "reply DONE" >/dev/null 2>&1 || true

if [ -f "$MARKER" ]; then
	echo "PASS [$TAG]: OMP invoked the factory in $(python3 -c "import json;print(json.load(open('$CLONE/package.json'))['omp']['extensions'][0])")"
	rm -rf "$CLONE" "$PROJ" "$MARKER"
	exit 0
fi
echo "FAIL [$TAG]: the factory never ran, so OMP did not load that entry"
exit 1
