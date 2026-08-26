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
# Not part of the suite: it needs `bd` on PATH and it starts Dolt servers, neither of
# which CI has. Run it by hand when the storage assumption changes.
#
#   sh scripts/probe-copied-checkout.sh
#
# Measured with beads 1.1.2 on darwin/arm64, both modes SHARED:
#
#   per-project  orig_db=cp_per_project_orig  copy_db=cp_per_project_orig  1 -> 2
#   shared       orig_db=cp_shared_orig       copy_db=cp_shared_orig       1 -> 2
#
# The database name is the telling column: the copy resolves to the ORIGINAL's database,
# not to its own directory basename, so bd reads `dolt_database` from the copied
# `.beads/metadata.json` rather than deriving it from the path.
#
# The counts are a delta, not absolutes, and the shared arm shows why: its server is
# machine-wide, so deleting the checkout does not drop the database and a re-run starts
# from whatever the last run left. Only `after > before` carries the verdict.

set -eu

probe() {
	mode_flag=$1
	label=$2
	orig=${TMPDIR:-/tmp}/cp-$label-orig
	copy=${TMPDIR:-/tmp}/cp-$label-COPY-differently-named

	rm -rf "$orig" "$copy"
	mkdir -p "$orig"
	cd "$orig"
	git init -q -b main
	git config user.email probe@test.local
	git config user.name Probe
	bd init --init-if-missing --skip-hooks "$mode_flag" -q --non-interactive >/dev/null 2>&1

	bd create "original-bead" --type task >/dev/null 2>&1
	before=$(bd list --json 2>/dev/null | grep -c '"id"' || echo 0)

	# The whole checkout, including .beads, lands under a different directory name.
	cp -R "$orig" "$copy"
	cd "$copy"

	seen=$(bd list --json 2>/dev/null | grep -c '"id"' || echo 0)
	db_copy=$(bd dolt show 2>/dev/null | awk '/Database:/{print $2}')
	bd create "written-from-copy" --type task >/dev/null 2>&1 || true

	cd "$orig"
	after=$(bd list --json 2>/dev/null | grep -c '"id"' || echo 0)
	db_orig=$(bd dolt show 2>/dev/null | awk '/Database:/{print $2}')

	printf '%-13s orig_db=%-22s copy_db=%-22s before=%s copy_saw=%s after=%s  ' \
		"$label" "$db_orig" "$db_copy" "$before" "$seen" "$after"
	if [ "$after" -gt "$before" ]; then
		echo "SHARED (the copy's write reached the original)"
	else
		echo "FORKED (the copy's write was lost)"
	fi

	rm -rf "$orig" "$copy"
}

command -v bd >/dev/null 2>&1 || {
	echo "bd is not on PATH: nothing to probe" >&2
	exit 2
}

probe --server per-project
probe --shared-server shared
