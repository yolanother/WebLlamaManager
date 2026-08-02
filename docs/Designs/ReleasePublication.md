<!--
Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
in the repository root.

Design and recovery contract for transferring signed Llama Manager release
snapshots from the NAS publication tree to the public download host without
exposing missing, partial, or checksum-inconsistent artifacts.
-->

# Atomic live release publication

## Invariant

The public download host must continue serving the last-known-good release until
every file in a newly published snapshot is present. In particular,
`images/SHA256SUMS` and its ISO must become reachable through the same stable
`images` symlink; the manifest must never lead the payload.

The NAS publisher already creates immutable directories under
`releases/{apt,images}/...` and atomically replaces top-level relative symlinks
such as `apt`, `images`, and `images-nvidia-spark`. The live sync preserves that
model instead of flattening it.

## Transfer sequence

`distribution/release-service/sync-public-tree.sh` performs the live transfer:

1. Discover and validate every top-level release symlink. Targets must be
   relative directories contained by the public tree.
2. Transfer only those active immutable target directories, preserving their
   `releases/...` paths. `rsync --delay-updates` keeps partial regular files out
   of their final names.
3. Recheck every local symlink target. If a publisher changed one during the
   transfer, abort before remote activation.
4. Create a temporary symlink beside each live pointer and rename it over the
   old link. POSIX rename makes each activation atomic; this happens only after
   all payload rsyncs succeed.
5. The runner verifies public HTTP status, checksum signatures, and ISO range
   reads before pruning old remote snapshots.

An interrupted payload transfer can leave an unreferenced partial snapshot, but
all stable live pointers continue selecting the previous complete snapshots. A
rerun safely resumes the immutable target and activates it after completion.

Inactive historical snapshots are intentionally not copied. This prevents a
snapshot previously pruned from the capacity-constrained live host from being
reintroduced by the next release.

## Alternatives rejected

- A single broad-tree rsync publishes small symlinks and manifests before large
  images and retransmits inactive history.
- `--delay-updates` alone protects regular-file replacement but does not provide
  the required ordering between a symlink and its new referent.
- Copying the broad tree in one payload pass and again for symlinks still walks
  every historical snapshot and makes the second pass broader than activation.

## Verification and recovery

Run the hermetic regression directly:

```bash
tests/release-service/run-tests.sh
```

It covers successful activation, manifest/image coherence, omission of inactive
history, and a forced failure after one payload transfer that leaves the old APT
and image pointers serving.

After deployment, verify the real host with the release runner's existing HTTP,
signature, and ISO range checks. If a live sync fails, rerun the release sync;
the previous pointers remain valid until the retry finishes every active target.
