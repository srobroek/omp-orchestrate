#!/bin/sh
# Do A and B produce the same durable record, through the production sequence?
#
# Bead omp-orchestrate-0wc withdrew a claim that they do. That claim compared eight fields
# (id, ephemeral flag, metadata.role, other envelope keys, labels, dependency COUNT, comment
# COUNT, queue reachability) and skipped events, parent, status, assignee, exact dependency
# content, exact comment content, and the production sequence itself.
#
#   A: bd update <wisp> --set-metadata role=implementer ; bd promote <wisp> --reason "..."
#   B: bd update <wisp> --persistent --set-metadata role=implementer
#
# This drives both arms through claim, enrich, reparent, dependency, route, promote and
# release -- the order a triager would use -- and then diffs the WHOLE record rather than a
# chosen subset.
#
# Every mutation's exit code is checked, and the pre-divergence state is asserted. A silenced
# failure would otherwise surface later as a missing comment and read exactly like the
# difference this probe exists to find.
#
# Run: sh scripts/probe-promote-equivalence.sh
# Exit 0 means identical on every compared field. Exit 1 prints the diff. Exit 3 means a
# control failed, so the comparison never happened and its silence proves nothing.

set -eu

command -v bd >/dev/null 2>&1 || { echo "bd is not on PATH: nothing to probe"; exit 2; }

root=$(mktemp -d "${TMPDIR:-/tmp}/orc-promote-XXXXXX")
trap 'rm -r -- "$root" >/dev/null 2>&1 || true' EXIT
cd "$root"

git init -q -b main
git config user.email probe@test.local
git config user.name Probe
echo seed > seed
git add seed
git commit -q --no-gpg-sign -m seed

# --skip-hooks because core.hooksPath belongs to git-defender on this host and bd would
# repoint it. Embedded is the default and starts no server.
bd init --init-if-missing --skip-hooks --non-interactive --prefix probe -q >/dev/null 2>&1
export BEADS_ACTOR=probe

id_of() {
	python3 -c 'import json,sys;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) else d)["id"])'
}
field_of() {
	python3 -c "import json,sys;d=json.load(sys.stdin);r=d[0] if isinstance(d,list) else d;print(r.get('$1',''))"
}
control() { echo "CONTROL FAILED: $1"; exit 3; }

epic=$(bd create "epic" --type epic --json 2>/dev/null | id_of)
target=$(bd create "downstream work" --type task --json 2>/dev/null | id_of)

mk() {
	bd create "$1" --type bug --ephemeral --wisp-type escalation --json 2>/dev/null | id_of
}
a=$(mk "arm A")
b=$(mk "arm B")

# Everything before the arms diverge, identical on both.
prepare() {
	w=$1
	# claim
	bd update "$w" --status in_progress --assignee probe-worker >/dev/null 2>&1 ||
		control "claim did not succeed on $w"
	# enrich
	bd comment "$w" "archaeology: found in passing" >/dev/null 2>&1 ||
		control "bd comment did not succeed on $w"
	# reparent
	bd update "$w" --parent "$epic" >/dev/null 2>&1 ||
		control "reparent did not succeed on $w"
	# dependency, whose exact content the earlier probe only counted
	bd dep add "$target" "$w" >/dev/null 2>&1 ||
		control "bd dep add did not succeed on $w"

	# Asserted BEFORE divergence, so a later difference is caused by the arms rather than by a
	# write that never landed. Status is used because it IS observable on a wisp.
	#
	# comment_count deliberately is NOT asserted here. Measured on beads 1.1.2: `bd comment`
	# on a wisp prints `Comment added` while `bd show --json` reports `comment_count: 0` and
	# `comments: null`, where the identical call on a permanent bead reports 1. An earlier
	# version of this probe asserted 1 here and failed its own control, which is what revealed
	# that arm A's single comment came from `bd promote`'s promotion note rather than from the
	# enrichment above. Whether the enrichment survives promotion is now part of the FINDING
	# below, not a precondition.
	s=$(bd show "$w" --json 2>/dev/null | field_of status)
	[ "$s" = "in_progress" ] || control "$w shows status=$s before the arms diverge, expected in_progress"
}
prepare "$a"
prepare "$b"

# A: route, then promote as a separate command.
bd update "$a" --set-metadata role=implementer >/dev/null 2>&1 ||
	control "arm A metadata write did not succeed"
bd promote "$a" --reason "triaged: routed to the implementer queue" >/dev/null 2>&1 ||
	control "bd promote did not succeed on arm A"

# B: route and persist in one command.
bd update "$b" --persistent --set-metadata role=implementer >/dev/null 2>&1 ||
	control "arm B persistent write did not succeed"

# release, identical on both, after the divergent step
for w in "$a" "$b"; do
	bd update "$w" --assignee "" --status open >/dev/null 2>&1 ||
		control "release did not succeed on $w"
done

dump() {
	bd show "$1" --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
r = d[0] if isinstance(d, list) else d
# Volatile by nature: two different beads always differ here, and comparing them would
# report noise as a finding.
for k in ("id", "created_at", "updated_at", "closed_at", "last_activity", "title", "started_at"):
    r.pop(k, None)
# Comment ids and timestamps are volatile; the TEXT and the count are the claim.
r["comments"] = [c.get("text") or c.get("content") or c.get("body") for c in (r.get("comments") or [])]
print(json.dumps(r, indent=2, sort_keys=True, default=str))
'
}

dump "$a" > a.json
dump "$b" > b.json

echo "=== A version history ==="
bd history "$a" 2>/dev/null | sed -n '1,10p' || echo "(none)"
echo "=== B version history ==="
bd history "$b" 2>/dev/null | sed -n '1,10p' || echo "(none)"

echo "=== dependency reaching each arm, as recorded on the downstream bead ==="
bd show "$target" --json 2>/dev/null |
	python3 -c 'import json,sys;d=json.load(sys.stdin);r=d[0] if isinstance(d,list) else d;print(json.dumps(r.get("dependencies"),default=str))'

echo "=== whole-record diff, A versus B ==="
if diff -u a.json b.json; then
	echo "IDENTICAL on every compared field"
	exit 0
fi

echo
echo "The arms differ on the fields above, so A and B are not interchangeable."
echo "The withdrawn claim in bead omp-orchestrate-0wc stays withdrawn."
exit 1
