# Qwen3.8 Flash-Next weights and Drakemore maintenance

The manager's Flash-Next planner and podcast routes must select the same complete
GGUF shard set. Unsloth `UD-IQ4_XS` is the preferred replacement for Drakemore's
legacy `UD-IQ3_XXS` download because the researched Strata version supports IQ4 and
explicitly rejects that Unsloth IQ3 quantization.

This document records the route contract, verified host preparation and manager
deployment through 2026-10-08. The replacement weights, nightly cache job and
reviewed manager route update are installed. Strata itself has not been
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
`cron.service`, and lock exclusion were verified. The first scheduled invocation
was 2026-10-08 at 02:00 UTC; installation and command validation do not independently
prove that scheduled invocation ran. Pruning unused cache means later builds may rebuild
those layers; it does not purge worker logs, images, containers, or volumes.

## Deployment and qualification — 2026-10-08

The reviewed route selector landed on local and remote main at `707ae50`;
the independently reviewed serving-context correction landed at `801d962`.
The complete API suite passed 1,669 tests, including seven generated-context
regressions. The unchanged UI previously passed 28 tests and its production
build. The native verification commands are `node --test api/*.test.js`
and, from `ui/`, `npm test` followed by `npm run build`.
Canonical Debian packaging contracts passed. Core package `llama-manager` 1.2.0
was authenticated against a private signed repository and installed through APT;
its SHA256 is `50ed4ddc5768d381d0b9e916498b253bd932aca0d9e80ae9ddb94810c85eef2d`.
Only its declared missing `nvme-cli` dependency was added; engine and driver
packages were preserved. Existing conffiles were retained. Installed API files
byte-match the reviewed source, and the manager is active. The exact previous
core package is retained for rollback.

The host's installed archive key predates the current release key. The current
public key was delivered over an authenticated SSH loopback channel and checked
against primary fingerprint `D544964FB38C6CDD680898205B2C748C7B29A1A8`.
Verification followed signed `InRelease` → package-index SHA256 → core-package
SHA256 before a guarded local-package APT transaction. APT ignored an attempted
stdin source; that attempt installed nothing. Persistent archive trust and source
lists were unchanged; future public-APT trust repair is tracked separately by `T31be340a26806`.

Qualification temporarily used one model slot and disabled the discrete
accelerator, isolating the Strix Halo. Actual child arguments confirmed IQ4,
`mmap`, lazy loading, 16 threads, one parallel slot and 65,536 context tokens;
the podcast route used 16,384. `cpu-moe=1` enables CPU execution for all experts;
it does not mean one expert layer. No RPC or discrete-device flags were present.

| Measurement | Current default-big, Qwen3.6 | Flash-Next IQ4, CPU experts |
| --- | ---: | ---: |
| Six matched novel-text requests, median decode | 52.07 tok/s | 16.15 tok/s |
| Time to first content, matched requests | 0.17–0.33 s | 1.02–3.68 s |
| Separate first 16K load, decode / TTFT | — | 12.44 tok/s / 19.16 s |

Matched requests used identical saved prompts, seed 421, temperature 0.2,
192 output tokens, disabled thinking and local-only routing. Engine decode
timing is distinct from wall time and first-content latency. All matched prompt
cache counts were zero. An earlier baseline included one 502 and substantial
cold delays; the later fully recorded six-request baseline passed.

All twelve canonical requests completed without transport errors, crashes,
kernel OOMs or new GPU faults. Three arithmetic JSON responses matched exactly.
Three longer retrieval responses found the correct facts but varied field types
(zero-padded string IDs and a boolean approval value); their strict schema checks
failed. These requests reached about 1,355 input tokens; they do not qualify a
full 64K prompt or the trained 256K maximum.

**The deployed CPU-expert profile fails the user's speed gate.** Default-big,
default-small and auto routing remain on their original targets. Those two chat
groups are the custom aliases; auto delegates to them. Vision remains separate.
An isolated trial with the same engine, `--n-cpu-moe 24`, explicit `ROCm0`,
64K context and mmap/lazy loading crashed during loading with exit 139. A retry
with the normal launcher's `GGML_HIP_UMA=1` and ROCm environment also crashed in
`libamdhip64.so.7.2.70204`. Neither produced a GPU throughput measurement. These
two observations do not establish that every GPU configuration or Strata fails.
No OOM or GPU reset accompanied them; minimum available RAM was about 94.53 GB
and 88.74 GB respectively.

The bounded trial guard stopped manager admission, verified no managed engine
remained, launched under the service identity in the existing ROCm namespace,
and terminated only its own process group. Automatic approval review initially
rejected a guard without automatic manager recovery; the corrected guard added
recovery and ran. Both trials restored `modelsMax=2`, enabled the discrete
accelerator setting and started the manager. Default-big responded after each
recovery, at 51.65 and 48.71 tok/s respectively, including cold model-load latency.
Aliases and GPU reservation priorities remained unchanged throughout.

Benchmark task `T31bdc3649c80c` remains gated by failed speed and GPU-profile
stability; alias task `T31bdc3ef6c809` has not been implemented. Runtime follow-up
`T31be3801bd823` records the reproducible HIP load crash, exact flags and logs.
A compatible GPU profile or a separately qualified Strata runtime must pass the
same baseline and repeated-response gate before migration. Strata has not been
installed or measured, and no temporary Flash process remains running.

Container log reading timed out after the 2026-10-07 cleanup. Docker
`live-restore` was enabled, but automatic approval review rejected a daemon
restart; this work did not restart it. On 2026-10-08, reading the current speech
worker's log succeeds. The previous asset fleet had already stopped before
today's work. Seventeen oversized stopped-container logs were archived and
trimmed with stopped-state, inode and writable-descriptor checks, recovering
about 2.01 TB; root had about 2.04 TB free afterward. The live speech worker's
identity and start time were preserved. A guarded daemon restart is now approved
but has not been needed or performed. Native Pods log rotation and polling-noise
reduction are separately tracked by `T31b6de0bfc85a`; the nightly build-cache job
does not implement that follow-up.

The storage epic is `T31b6cdaa5c855`, the nightly cron task is `T31b6d93ab3871`,
and the route-change workstream is `T31b6e9b345867`. These records retain command
results, ownership, and recovery notes for continuing the work.
