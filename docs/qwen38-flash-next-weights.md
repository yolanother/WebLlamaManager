# Qwen3.8 Flash-Next weights and Drakemore maintenance

The manager's Flash-Next planner and podcast routes must select the same complete
GGUF shard set. Unsloth `UD-IQ4_XS` is the preferred replacement for Drakemore's
legacy `UD-IQ3_XXS` download because the researched Strata version supports IQ4 and
explicitly rejects that Unsloth IQ3 quantization.

This document records the route contract and verified host preparation on
2026-10-07. The replacement weights and nightly cache job are installed; the
manager route update has not yet been deployed. Strata itself has not been
deployed or benchmarked on Drakemore.

## Route selection

Both quantizations live under
`/volumes/models/unsloth_Qwen3.8-Flash-Next-GGUF`. Each set has three files named
`Qwen3.8-Flash-Next-<quantization>-00001-of-00003.gguf` through
`00003-of-00003.gguf`. Selection requires all three shard files; the router receives
the first shard and resolves the remaining shards from its filename.

| Installed files | Selected planner weights |
| --- | --- |
| Complete `UD-IQ4_XS` set | First IQ4 shard |
| Complete `UD-IQ3_XXS` set only | First legacy IQ3 shard |
| Both complete sets | First IQ4 shard |
| Incomplete IQ4 set and complete IQ3 set | First legacy IQ3 shard |
| No complete set | Planner unavailable; no Flash-Next planner or podcast preset published |

The canonical model ID remains `unsloth_Qwen3.8-Flash-Next-GGUF`, with a trained
maximum of 262,144 tokens. The router passes its configured serving context to
both the Flash planner and Qwen3.6 worker, aligning allocation with admission
checks. Drakemore currently configures 65,536 tokens; explicit serving contexts
are capped at the trained maximum. Standalone helper calls without a context
retain the full-window default. The separate
`podcast-qwen3.8-16k` route keeps its 16,384-token context. Both routes use the
selected first shard explicitly, so directory scanning cannot select a different
quantization for one route. Duo planner availability uses the same selection;
its Qwen3.6 worker requirements remain unchanged.

In `api/engines.js`, `selectQwen38FlashNextWeights({ modelsDir, fileExists })`
returns the selected first-shard path or `null`. It checks the presence of all
three expected filenames through the supplied predicate; it does not inspect
GGUF contents or verify checksums. The server's `duoWeightPaths()` supplies
`existsSync` and shares that result between availability and preset generation.

`qwen38FlashNextPresetSection()` and `podcastQwen38PresetSection()` each accept
the optional `weightsPath` input. A selected path is authoritative; `null` omits
the section. Omitting the input retains the earlier `weightsExist` gate, canonical
directory discovery, and podcast IQ3 filename for existing helper callers. The
manager passes the selector's result to both helpers, so its routes always use
the shared selection rather than that compatibility behavior. These helpers do
not access the filesystem themselves.

Serving catalogs apply `qwen38FlashNextCatalogEntryAvailable()` to the canonical,
podcast, and repository-relative Flash-Next entries. `/v1/models` filters both
router results and its local-file fallback; `/api/models` filters `serverModels`.
Those catalogs require a complete selected planner set and omit incomplete
Flash-Next inventory rows, including an incomplete other quantization when a
complete set is available. This also removes stale canonical and podcast serving
rows when neither quantization is complete. Unrelated models retain their existing
catalog behavior.

The `localModels` field in the `/api/models` response still includes incomplete
files for storage inspection and cleanup. Seeing a filename there does not mean the model is
available for inference. The virtual Duo entry still requires its planner and
worker weights.

The weight change preserves `load-mode=mmap`, `lazy-mode=on`, `cpu-moe=1`,
`fit=off`, `parallel=1`, and thread selection from the physical core count.
It also preserves GPU reservation priorities. Strix Halo remains the intended
primary inference device; an idle RTX 3090 may be borrowed only while Pods and
Asset Forge reservations retain priority. A successful file selection does not
establish inference speed or memory capacity for the new quantization.

## Verified replacement provenance

The downloaded repository is
[`unsloth/Qwen3.8-Flash-Next-GGUF`](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF/tree/38bb39ee97821de2c9009abb7e93950eec396e66/UD-IQ4_XS),
pinned to revision `38bb39ee97821de2c9009abb7e93950eec396e66`. The three files
total **93,682,584,224 bytes**. All sizes and SHA-256 hashes were verified before
the files were flattened from the repository's `UD-IQ4_XS/` subdirectory into the
manager's model directory. `strata-weights-manifest.json` in that directory
records their provenance.

| Shard suffix | Bytes | SHA-256 |
| --- | ---: | --- |
| `00001-of-00003.gguf` | 10,946,624 | `5ce89370720f8bf90890f439361282104c1aa1482d4013bb9a50923e758e71a4` |
| `00002-of-00003.gguf` | 49,835,229,856 | `577a38a2392b40ca2193cea502e1d92f60b8cd370675d308e0ec21885d9daaa7` |
| `00003-of-00003.gguf` | 43,836,407,744 | `d4634e6d84f0ebb0940be15c90d3790bf6464e3dea3a1cddc567dc0e83ad8833` |

Every filename in the table begins with `Qwen3.8-Flash-Next-UD-IQ4_XS-`.
Do not rename IQ4 files to IQ3 filenames or publish a partially downloaded set.
Filesystem completeness for route discovery and checksum verification of a
download are separate checks.

The compatibility assessment used
[`Niko1221/Strata` at commit `82f46a8c8f475f001ad76d92f58f4a4f8ffb0253`](https://github.com/Niko1221/Strata/tree/82f46a8c8f475f001ad76d92f58f4a4f8ffb0253).
The IQ3 rejection applies to that researched Strata setup; legacy llama-manager
installations with complete IQ3 weights retain their fallback route.

## Storage recovery and nightly cache purge

Before cleanup, Drakemore's root filesystem had zero available bytes. Docker's
build-cache report contained shared image layers, so its logical cache total was
not a reliable measure of physical disk space recoverable. The much larger
consumer was unbounded container `json-file` logs.

Unused build cache was pruned without deleting images, containers, or volumes.
The inactive legacy three-shard IQ3 model was removed through the manager's
model-delete API, recovering 81,961,823,936 logical bytes. Oversized worker logs
had their last 4 MiB archived before same-inode truncation; the archive and
container process identities are under
`/var/lib/llama-manager/maintenance/storage-20261007T072354Z`. APT cache was also
cleaned. Qwen3.6 remained active and all 18 asset workers were preserved.

`/etc/cron.d/drakemore-build-cache-prune` runs as root at **02:00 UTC every night**
on Drakemore, whose timezone is `Etc/UTC`. Its command is:

```sh
flock -n /run/lock/drakemore-build-cache-prune.lock /usr/bin/docker builder prune --all --force
```

The job overwrites `/var/log/drakemore-build-cache-prune.log` each run and uses a
nonblocking lock to skip overlapping invocations. File ownership and permissions
are `root:root` and `0644`. The installed job's command, final newline, active
`cron.service`, and lock exclusion were verified. Its first scheduled invocation
is 2026-10-08 at 02:00 UTC. Pruning unused cache means later builds may rebuild
those layers; it does not purge worker logs, images, containers, or volumes.

## Remaining verification and deployment

The reviewed route changes landed on local and remote main at `707ae50` on
2026-10-08. The final catalog fix passed the API suite (1,662 tests); the UI suite
(28 tests) and production UI build passed during route integration. The serving
context correction requires its own regression checks and review. A signed
APT deployment under the [package upgrade procedure](Utilities/package-installation.md)
remains pending. The native verification commands are `node --test api/*.test.js`
and, from `ui/`, `npm test` followed by `npm run build`.
Verify the generated canonical and podcast presets both point to the first IQ4
shard with their existing context and load settings. Route discovery can be
checked without loading the 93.7 GB planner alongside active Qwen3.6 or claiming
the RTX 3090 from asset workers.

Container log reading timed out after the 2026-10-07 cleanup. Docker
`live-restore` was enabled, but automatic approval review rejected a daemon
restart; this work did not restart it. On 2026-10-08, reading the current speech
worker's log succeeds. The previous asset fleet had already stopped before
today's work. Native Pods log rotation and polling-noise
reduction are separately tracked by `T31b6de0bfc85a`; the nightly build-cache job
does not implement that follow-up.

The storage epic is `T31b6cdaa5c855`, the nightly cron task is `T31b6d93ab3871`,
and the route-change workstream is `T31b6e9b345867`. These records retain command
results, ownership, and recovery notes for continuing the work.
