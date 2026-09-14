# Beads store

The run's ledger is one Beads database on the machine's shared Dolt server. `bd` finds it
from the tracked `.beads/metadata.json`, so every clone OMP makes for an isolated worker
reads and writes the same database as the primary checkout.

## Mode

`.beads/metadata.json` pins `"dolt_mode": "server"` and names the database in
`dolt_database`; `.beads/config.yaml` carries `dolt.shared-server: true`. The server runs
from `~/.beads/shared-server/` on port 3308. `bd dolt status` prints `Mode: shared server`
when the project is in this mode.

Three carriers can turn shared-server mode on, with different results on bd 1.2.2:

| Carrier | `bd init` result | Effect on an embedded project |
|---|---|---|
| `bd init --shared-server` | complete: server database created | none |
| `BEADS_DOLT_SHARED_SERVER=true` in the environment | complete | every `bd` command fails with `database not found` |
| `dolt.shared-server: true` in `~/.config/bd/config.yaml` | incomplete: `metadata.json` says server, but the database is never created | same failure |

The plugin refuses its ledger tools when `dolt_mode` is anything but `server`, because a
native isolated clone copies `.beads/embeddeddolt/` and the worker would then write to a fork
nobody reads.

## Migrate an embedded project

Run from the project root with `BEADS_ACTOR` set. `<dir>` is a backup directory outside the
checkout; `<prefix>` is the id prefix of any existing bead.

1. `bd export > issues.jsonl`, then `bd backup init <dir> && bd backup sync`.
2. When `origin` carries no `refs/dolt/*`:
   `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`,
   set `dolt_mode` to `"server"` in `.beads/metadata.json`, add `dolt.shared-server: true`
   to `.beads/config.yaml`, then `bd backup restore --force <dir>`.
3. When `origin` carries `refs/dolt/data`: `bd dolt push` (a refused non-fast-forward means
   `bd dolt pull` once, then push again), make the same two file edits, then
   `bd bootstrap --yes`.
4. Verify: `bd list --all --json | jq length` equals the pre-migration count and `bd export`
   parses equal to `issues.jsonl` ignoring `updated_at`. Move `.beads/embeddeddolt` out of
   the checkout and confirm the count once more.
5. Commit `.beads/config.yaml` and `.beads/metadata.json`. A clone on another machine runs
   `bd bootstrap` once.

## Hazards

- **Prefix overlap.** `dolt_database` defaults to the issue prefix, so two projects that
  share a prefix share one database. `dolt --host 127.0.0.1 --port 3308 --user root
  --password '' --no-tls sql -q "SHOW DATABASES"` lists what the server holds; pass a
  distinct `--prefix` to `bd init`.
- **Server stopped.** Every read and write fails closed within a second with
  `Dolt server unreachable at 127.0.0.1:3308`; nothing auto-starts. `bd dolt start` from any
  shared-mode project takes about one second. `bd init` in a second project refuses to start
  a rival server on the same port.
- **Push scope.** `bd dolt push` sends the project database only, to `sync.remote` in
  `.beads/config.yaml` or to `origin`. The payload is the whole database: bead bodies,
  comments, and actor strings. `bd bootstrap` on a fresh clone pulls it and repairs a
  hand-edited `dolt_database` from the tracked `project_id`.
- **Convergence.** A `cp -R` copy, a linked worktree, and a fresh `git clone` on the same
  machine all reach the same server and database with no environment variable; a write in
  any of them is visible in all of them.
