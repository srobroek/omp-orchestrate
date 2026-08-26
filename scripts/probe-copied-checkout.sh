#!/bin/sh
# Does a copied checkout reach the run's database, or fork a private one?
#
# Two things in this repository rest on the answer, and both were inferences until this
# probe existed:
#
#   1. src/beads-mode.ts accepts `per-project` and `shared server` because a filesystem
#      copy cannot redirect a host and port.
#   2. The retired `bd -C <run repo>` pin was justified by the same property. Under the
#      embedded engine bd resolves by walking up from the working directory, so a copy is
#      a second writable database; the pin was guarding that, and server mode removes it.
#
# This asserts rather than narrates. Three checks per mode, and the script exits nonzero
# when any of them fails, so automation cannot read a disproved assumption as success:
#
#   - the copy resolves to the ORIGINAL's database name
#   - the copy reads the same bead count the original had
#   - a write from the copy raises the original's count
#
# The write is deliberately unguarded by `|| true`: a create that fails from the copy is
# the finding, not noise to swallow.
#
# Not part of the suite: it needs `bd` on PATH and it starts Dolt servers, neither of
# which CI has. Run it by hand when the storage assumption changes.
#
#   sh scripts/probe-copied-checkout.sh
#
# Measured with beads 1.1.2 on darwin/arm64: both modes SHARED, and the database name is
# the telling column. The copy resolves to the original's database, not to its own
# directory basename, so bd reads `dolt_database` from the copied `.beads/metadata.json`
# rather than deriving it from the path.
#
# Counts are a delta, not absolutes, and the shared arm shows why: its server is
# machine-wide, so deleting the checkout does not drop the database and a re-run starts
# from whatever the last run left. Only the three assertions above carry a verdict.

set -eu

failures=0
workdirs=""

cleanup() {
	for stale in $workdirs; do
		rm -rf "$stale"
	done
}
trap cleanup EXIT HUP INT TERM

beads_count() {
	# `grep -c` exits 1 on no match, which `set -e` would treat as fatal. It has already
	# printed its 0 by then, so this must not print another: `|| echo 0` yielded "0\n0"
	# and every integer comparison downstream failed with a shell error instead of a verdict.
	count=$(bd list --json 2>/dev/null | grep -c '"id"' || true)
	case $count in
		'' | *[!0-9]*) count=0 ;;
	esac
	printf '%s' "$count"
}

probe() {
	mode_flag=$1
	label=$2
	orig=${TMPDIR:-/tmp}/cp-$label-orig
	copy=${TMPDIR:-/tmp}/cp-$label-COPY-differently-named
	workdirs="$workdirs $orig $copy"

	rm -rf "$orig" "$copy"
	mkdir -p "$orig"
	cd "$orig"
	git init -q -b main
	git config user.email probe@test.local
	git config user.name Probe
	bd init --init-if-missing --skip-hooks "$mode_flag" -q --non-interactive >/dev/null 2>&1

	bd create "original-bead" --type task >/dev/null 2>&1
	before=$(beads_count)
	db_orig=$(bd dolt show 2>/dev/null | awk '/Database:/{print $2}')

	# The whole checkout, including .beads, lands under a different directory name.
	cp -R "$orig" "$copy"
	cd "$copy"
	seen=$(beads_count)
	db_copy=$(bd dolt show 2>/dev/null | awk '/Database:/{print $2}')

	ok=yes
	if ! bd create "written-from-copy" --type task >/dev/null 2>&1; then
		echo "  FAIL [$label] the copy could not write at all"
		ok=no
	fi

	cd "$orig"
	after=$(beads_count)

	if [ "$db_copy" != "$db_orig" ]; then
		echo "  FAIL [$label] copy resolved database '$db_copy', original is '$db_orig'"
		ok=no
	fi
	if [ "$seen" -ne "$before" ]; then
		echo "  FAIL [$label] copy read $seen beads, original held $before"
		ok=no
	fi
	if [ "$after" -le "$before" ]; then
		echo "  FAIL [$label] the copy's write did not reach the original ($before -> $after)"
		ok=no
	fi

	if [ "$ok" = yes ]; then
		printf 'SHARED  %-13s db=%-24s %s -> %s\n' "$label" "$db_orig" "$before" "$after"
	else
		printf 'FORKED  %-13s db_orig=%s db_copy=%s %s -> %s\n' "$label" "$db_orig" "$db_copy" "$before" "$after"
		failures=$((failures + 1))
	fi
}

command -v bd >/dev/null 2>&1 || {
	echo "bd is not on PATH: nothing to probe" >&2
	exit 2
}

probe --server per-project
probe --shared-server shared

if [ "$failures" -ne 0 ]; then
	echo "$failures mode(s) forked: a copied checkout does not reach the run's database" >&2
	exit 1
fi
echo "both server modes share one database across a copied checkout"
