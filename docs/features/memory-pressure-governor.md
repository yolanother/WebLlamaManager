<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Documents the runtime memory-pressure governor: why an OOM kill of llama-server
panics this host at the kernel level, how the three-band hysteresis governor
sheds resident models gracefully before the kernel's OOM killer can fire, how it
interacts with desired-model residency and remote offload, and the operator
knobs under config.guard. Read this before changing any memory threshold or the
OOM score of the llama-manager service.
-->

# Memory-Pressure Governor

## Why this exists: an OOM kill panics the box

On this host (GMKtec EVO-X2, Strix Halo, kernel `7.0.0-28-generic`) the kernel
OOM killer is **not** a safe backstop for `llama-server`. Killing it panics the
entire machine.

Four hard resets — 2026-07-30 03:03, and 2026-08-02 at 02:12, 10:56 and 19:18 —
carry a byte-identical trace:

```
BUG: kernel NULL pointer dereference, address: 0000000000000050
RIP: 0010:amdgpu_hmm_range_valid+0x16/0x40 [amdgpu]
Call Trace:
  svm_range_validate_and_map → svm_range_set_attr → svm_ioctl
  → kfd_ioctl_svm → kfd_ioctl → __x64_sys_ioctl → do_syscall_64
Comm: llama-server
```

**In every one of the four, the PID the OOM killer chose is the same PID that
oopsed 0.4–0.8 s later** (4137241 / 3787803 / 3779279 / 3249763). The chain is:

1. Memory exhaustion — every dump shows `all_unreclaimable? yes` and `Free swap`
   of only 36–144 kB.
2. The OOM killer SIGKILLs `llama-server`.
3. The dying process still has a KFD SVM ioctl in flight; its mmu-notifier is
   torn down underneath it.
4. `range->notifier` becomes NULL, `amdgpu_hmm_range_valid` reads `NULL+0x50`,
   and the kernel dies.

The disassembly confirms the mechanism: `mov rax,[rdi]` loads `range->notifier`
(RAX=0), then `cmp [rax+0x50],rdx` faults with `CR2=0x50`. It is an **upstream
amdgpu teardown race**, not failing hardware.

A *graceful* unload avoids it entirely. `POST /models/unload` frees the weights
in-process: the router stops issuing ioctls, then releases the KFD mappings in
order. There is no async SIGKILL landing mid-ioctl, so there is no race.

> **Do not "fix" this by making something else the OOM victim and calling it
> done.** That only changes which process the kernel picks; it does not make
> killing `llama-server` safe. The governor is the actual mitigation.

## The gap it closes

`resource-guard.js` was **admission-time only**. `planMemoryRecovery()`
deliberately returns `serve` once a model is resident:

```js
// Already-loaded -> its memory is already committed, so a low MemAvailable is
// expected; refusing would be a false positive.
if (!fileBytes || alreadyLoaded) { ... }
```

That is correct for admission, but it meant **nothing watched memory after the
model loaded**. Parallel builds could walk the box down to the kernel watermark
floor unobserved — at the final panic, `Normal free:100584kB` against
`min:99612kB`.

## How it works

A 1 s tick in `api/server.js` samples `MemAvailable` and feeds
`memoryPressureDecision()` (`api/resource-guard.js`), a three-band hysteresis
state machine:

| State | Trigger | Behaviour |
|---|---|---|
| `normal` | ≥ `memResumeAboveGb` (32 GiB) | Model resident; residency restore permitted. |
| `watch` | < `memWatchBelowGb` (24 GiB) | Offload new work to remote backends. Model **stays** resident — the pressure may pass. |
| `shed` | < `memShedBelowGb` (16 GiB) | Gracefully unload resident models now. |

Design points worth knowing before you change anything:

- **1 s poll, not 5 s.** This is a race against the kernel. A parallel build can
  allocate tens of GiB in seconds and freeing ~60 GiB is not instant. Losing the
  race costs a reboot, not a slow request.
- **16 GiB is deliberately generous.** It is not "how little memory is
  acceptable", it is "how much runway the unload needs".
- **Fails open.** `availableBytes <= 0` means `/proc/meminfo` was unreadable, not
  that the box is starved. Shedding on dark telemetry would be a self-inflicted
  outage. Mirrors `thermalDecision` ignoring all-zero reads.
- **Largest-first, re-measured between unloads.** Sheds the minimum needed, so a
  small embedding model survives if freeing the big one was enough.
- **Cooldown (`memShedCooldownMs`, 60 s).** `MemAvailable` lags an in-flight
  unload; without this the next tick would stampede the unload path.
- **Hysteresis to 32 GiB.** Recovering to 20 GiB is not enough to declare normal
   — flapping would let the residency restorer reload 60 GiB straight back into a
  still-strained box.

### Interaction with desired-model residency

`restoreDesiredResidentModels()` is gated on the governor being `normal`.
Without that gate the restorer would immediately reload exactly the weights the
governor just freed, and the box would oscillate.

Recovery is **lazy by design**: the next API request reloads the model through
the existing auto-switch path, and the admission-time guard refuses it if it
still will not fit. Nothing proactively reloads into a box that is still busy.

### Relationship to the thermal governor

They are deliberately different. The thermal governor **never** unloads — an idle
model is not a heat source, so unloading cannot cool the die and only destroys
service. Memory pressure is the opposite: unloading is the *only* thing that
helps, and it must happen before the kernel acts.

## Configuration

Under `config.guard` in `config.json`. Thresholds are in GiB for sanity.

| Key | Default | Meaning |
|---|---|---|
| `memShedBelowGb` | 16 | Shed resident models below this MemAvailable. |
| `memWatchBelowGb` | 24 | Stop taking new local work below this. |
| `memResumeAboveGb` | 32 | Only declare recovery above this (hysteresis). |
| `memShedCooldownMs` | 60000 | Grace period for an in-flight unload to land. |

Setting `guard.enabled: false` disables this governor along with the thermal one.

## Observability

- `/api/stats` exposes `memoryGuard`: `{ state, availableBytes, shed, at, reason }`.
- State transitions log to the `system` log as `[memory] <prev> -> <next>: <reason>`.
- Each shed logs `[memory] shed <model> (~N GiB)`.

## Host-level companions

The governor is the primary defence, but two host settings materially change how
much runway it has. Both live outside this repo:

1. **`OOMScoreAdjust` on `llama-manager.service`.** Note that
   `systemctl --user show -p DefaultOOMScoreAdjust` reports **200** — systemd
   sets the user manager's default to its own value (100) + 100, so *every* user
   service runs at 200. `llama-server` was never specially designated as the OOM
   victim; it simply always loses because `oom_score` scales with RSS and it is
   ~60 GB. Setting an explicit negative `OOMScoreAdjust` takes it out of the
   running without overriding anyone's intent.
2. **Swap size.** 8 GiB of swap on a 124 GiB box leaves the kernel almost no
   reclaim headroom, which is why every dump shows `all_unreclaimable? yes`.

## Verifying a change

```bash
cd api && node --test resource-guard.test.js   # governor logic
cd api && node --test                          # full suite
```

`memoryPressureDecision` is pure, so its behaviour is fully covered by unit
tests — including the fail-open, cooldown, hysteresis and
residency-suppression cases. Add a test there before changing a threshold.
