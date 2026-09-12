# Typed Entity Identifiers

## What changed

Tasks and projects are addressed by a human-readable, time-sortable identifier
instead of an opaque nanoid:

| Entity  | Shape                  | Example          |
|---------|------------------------|------------------|
| Task    | `T` + 10 hex + 3 hex   | `T29a4f1b8e27c3` |
| Project | `P` + 10 hex + 3 hex   | `P29a4f1b8e27c3` |

The prefix names the entity type, so an id is self-describing on sight. The 10
hex digits are milliseconds since a **2020 epoch** — offsetting from 2020 rather
than 1970 is what lets a millisecond timestamp fit in 10 digits at all. Fixed
zero-padded width makes ids sort lexicographically in creation order. The final
3 hex digits are a tail that separates ids minted in the same millisecond.

Total length is 14 characters, against 21 for the nanoid it replaces.

## Backwards compatibility: primary keys were NOT rewritten

Existing nanoid ids are referenced by git branch names (`orch-<task-id>-*`), PR
titles, task descriptions, 15 foreign keys into `tasks.id`, 53 into
`projects.id`, and free-text knowledge-graph refs that carry no FK constraint.
Rewriting the primary key would have invalidated all of them.

Instead:

- **Rows created before the change** keep their nanoid `id` and gain a
  `short_id` backfilled from `created_at`.
- **Rows created after the change** have the typed value in `id` itself and
  leave `short_id` null.
- Callers display `displayRef(row)`, which is `shortId ?? id` — the readable
  form in both cases.
- Both forms resolve to the same row, forever.

This left the ~107 `eq(tasks.id, …)` and ~109 `eq(projects.id, …)` query sites
and every foreign key untouched, and reduced each of the 32 insert sites to a
one-token change.

## Resolution

`services/entity-ref.ts` provides `resolveTaskId` / `resolveProjectId`, wired
into the task and project route plugins as a single `onRequest` hook that
canonicalizes the `:id` param. All 19 task and 17 project handlers therefore
accept either form with no per-handler change.

`isTypedId` is an **exact** shape match (`/^[TP][0-9a-f]{13}$/`), never a prefix
check. The live project id `P6aeFLv2_i38lsR39MqiM` already begins with `P`, so a
prefix-only test would misclassify existing projects as typed ids and send every
legacy lookup down the `short_id` path. A legacy ref short-circuits without
touching the database.

The shape rules live in `@orchestrator/shared` (`entity-id.ts`) because the
server, CLI, and web client must all answer "is this a typed id?" identically.

## Collision safety

The tail is **not** pure randomness. With 4096 values, the birthday bound puts a
20-row batch insert at roughly a 5% chance of collision — a primary key
violation for the batch task creators (`brainstorm-task-creator`,
`feature-installer`, `conversation-designer` all loop-insert). A test that mints
500 ids in one millisecond failed at 465 unique before this was fixed.

`generateTypedId` instead seeds the tail randomly **once per millisecond** and
increments it monotonically for every further id in that millisecond, making an
in-process batch collision-free by construction while the random seed keeps
separate processes from lining up. Unique indexes on both `short_id` columns are
the backstop.

The **backfill** uses `row_number()` partitioned by millisecond rather than
randomness, so it is collision-free by construction and reproducible.

## Ceilings

- 10 hex digits of ms-since-2020 overflow to 11 digits in **2054**, at which
  point ids grow a character and stop sorting against pre-2054 ids. Widen
  `TIMESTAMP_HEX_WIDTH` to 11 before then.
- The tail wraps after 4096 ids minted in a single millisecond.

## Running the migration

Migration `0077_typed_task_project_ids.sql` adds and backfills `short_id`. It
rewrites every existing task and project row, so **take a verified backup
first**:

```bash
./scripts/pre-migration-backup.sh
```

That wraps `db-backup.sh` and refuses to report success unless
`verify-pg-dump.sh` finds pg_dump's terminating marker. A byte-size threshold or
`gzip -t` passes on a truncated dump; only the marker distinguishes a usable
backup from a stub. It is deliberately a standalone operator step and not part
of container startup, because verifying dumps on the startup path previously
blocked the stack on pg_dump locks.

Note that the migration's journal `when` value must sit above the ledger
high-water mark. Drizzle silently skips forever any migration whose `when` falls
below it.
