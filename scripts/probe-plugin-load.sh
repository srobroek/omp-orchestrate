#!/bin/sh
# Deterministic packaging oracle: did OMP import and invoke THIS entry point?
#
# Run it whenever `omp.extensions` or the build changes. Always run a baseline branch
# too: an oracle that cannot detect a working load proves nothing, and two earlier
# attempts at this used needles absent from transcripts by design, so both reported
# failure against a branch that worked.
#
# No model output, no transcript archaeology. The clone's own extension factory writes a
# unique marker as its last statement, so the marker exists if and only if OMP resolved
# the manifest, imported that exact file, called its default export, and every
# registration completed. A failed model call cannot hide it, because factories run
# during session init. A throw mid-factory cannot leave a marker: the write is last.
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
HANDLER=/tmp/orc-$TAG-handler

rm -rf "$CLONE" "$PROJ" "$MARKER" "$HANDLER"
git clone -q --branch "$BRANCH" --single-branch "$HOME/personal/dev/omp-orchestrate" "$CLONE"

printf 'branch=%-28s dist=%-4s entry=%s\n' \
	"$BRANCH" \
	"$([ -d "$CLONE/dist" ] && echo YES || echo no)" \
	"$(python3 -c "import json;print(json.load(open('$CLONE/package.json'))['omp']['extensions'][0])")"

# Instrument the factory in the clone only. The parent repository is never touched.
python3 - "$CLONE" "$MARKER" "$HANDLER" <<'PY'
import pathlib, re, sys
clone, marker, handler = sys.argv[1], sys.argv[2], sys.argv[3]
src = pathlib.Path(clone) / "src" / "index.ts"
text = src.read_text()
m = re.search(r"^export default function [A-Za-z_]+\([^)]*\)[^\{]*\{", text, re.M)
if not m:
    raise SystemExit("could not find the default factory in src/index.ts")
# Last statement of the factory. The factory is the last construct in src/index.ts,
# so the file's final closing brace is the factory's closer — no brace counting.
closer = text.rfind("}")
if closer == -1:
    raise SystemExit("could not find the factory closer in src/index.ts")
text = text[:closer] + f'\trequire("node:fs").writeFileSync({marker!r}, "invoked");\n' + text[closer:]

# Second marker inside a registered handler, before its first guard, so dispatch is
# proved rather than inferred from registration.
h = re.search(r'pi\.on\("session_start",[^\{]*\{', text)
if not h:
    raise SystemExit("could not find the session_start registration")
text = text[: h.end()] + f'\n\t\trequire("node:fs").writeFileSync({handler!r}, "dispatched");' + text[h.end() :]
src.write_text(text)
print("instrumented factory and session_start handler")
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

ENTRY=$(python3 -c "import json;print(json.load(open('$CLONE/package.json'))['omp']['extensions'][0])")
printf 'factory invoked:  %s\n' "$([ -f "$MARKER" ] && echo yes || echo NO)"
printf 'handler dispatch: %s\n' "$([ -f "$HANDLER" ] && echo yes || echo NO)"

if [ -f "$MARKER" ] && [ -f "$HANDLER" ]; then
	echo "PASS [$TAG]: OMP loaded $ENTRY and dispatched a registered handler"
	rm -rf "$CLONE" "$PROJ" "$MARKER" "$HANDLER"
	exit 0
fi
echo "FAIL [$TAG]: $ENTRY did not load, or registered without dispatching"
exit 1
