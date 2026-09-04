# AMD Strix Halo (gfx1151) GPU Stability

Durable findings from a long debugging session on this box (AMD Ryzen AI MAX /
Strix Halo iGPU, `gfx1151`). The headline lesson: there are **two distinct GPU
failure modes** that were repeatedly conflated. They have different signatures,
different triggers, and different fixes. Get the framing right and both are
preventable.

> **Bottom line:** the box ran rock-solid for hours with one model resident, then
> "suddenly died" on the first model swap. That is not random — it is the second
> failure mode (the MES suspend wedge) firing exactly when the driver evicts a
> resident model. The first failure mode (illegal-opcode under inference) is a
> separate, already-fixed problem.

## TL;DR — current known-good mid-2026 gfx1151 stack

| Component | Known-good | Notes |
|---|---|---|
| **Kernel** | **6.18.4+** (installing 6.18.36) | Kernels `< 6.18.4` have a documented gfx1151 stability bug. We were on `6.17.12-061712-generic` (below the line). 6.19.x also OK but needs `HSA_OVERRIDE_GFX_VERSION=11.5.1`. |
| **ROCm** | **7.2.x** (run the 7.2.4 toolbox) | ROCm-7.0-RC + kernel-6.17 was the bad combo that emitted illegal opcodes. |
| **linux-firmware** | **>= 20260111** (we use tag `20260410` = MES `0x86`) | **AVOID `linux-firmware-20251125`** — it breaks ROCm on Strix Halo. |
| **amdgpu kernel params** | `amd_iommu=off amdgpu.gttsize=131072 ttm.pages_limit=31457280 amdgpu.runpm=0` | `amdgpu.cwsr_enable=0` was **REMOVED** (red herring; caused illegal-opcode faults of its own). |
| **HSA override** | `HSA_OVERRIDE_GFX_VERSION=11.5.1` | Required on Strix Halo. |
| **Manager wiring** | `DISTROBOX_CONTAINER=llama-rocm-7.2.4` + `LLAMA_SERVER_BIN=/usr/local/bin/llama-server` | Pin in the **systemd service env**, not just `.env` — dotenv won't override the systemd user env. The 7.2.4 toolbox ships a prebuilt `llama-server` (v9820). |

---

## The two distinct GPU failure modes

### Failure mode 1 — "Illegal opcode in command stream" (during inference)

- **Kernel signature:** `gfx_v11_0_bad_op_irq` / "Illegal opcode in command stream".
- **When:** during **inference**, continuously — roughly **every 20-35 s** under
  gpt-oss-120b — eventually hard-freezing the box.
- **Root cause:** the **ROCm 7.0-RC toolchain** (the kyuz0 `rocm-7rc-rocwmma`
  container) emitting **gfx1151-incompatible GPU kernels**. This is an
  *inference-time code-generation* bug, not a driver/queue bug.
- **Fix:** move to the **ROCm 7.2.4 toolbox**
  (`docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`), which ships a prebuilt
  `/usr/local/bin/llama-server` (v9820). **Verified clean: 15+ sustained
  inferences, 0 illegal opcodes.**

**Two leads were RULED OUT by direct test — do NOT re-try them:**

1. **`amdgpu.cwsr_enable=0`** — a red herring. It did *not* fix the opcode bug and
   caused its own illegal-opcode faults. It has been removed from the kernel
   cmdline.
2. **The `GGML_HIP_ROCWMMA_FATTN` build flag** — we rebuilt llama.cpp *with* it and
   the box **still faulted**. The toolchain (ROCm version) was the cause, not the
   build flag.

### Failure mode 2 — MES suspend wedge (during a model swap)

- **Kernel signature (in order):**
  ```
  amdgpu: MES failed to respond to msg=SUSPEND
  amdgpu: failed to suspend all gangs
  amdgpu: MES might be in unrecoverable state, issue a GPU reset
  amdgpu: GPU reset begin!
  amdgpu: remove_all_kfd_queues_mes: Failed to remove queue
  amdgpu: resume of IP block <vpe_v6_1> failed -110
  amdgpu: GPU reset end with ret = -110
  ```
- **Aftermath:** ROCm can no longer detect the GPU
  (`ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device is
  detected`), processes pin in **D-state**, and **only a reboot recovers it**.
- **When:** on a **model swap** — unloading/evicting a resident model — **NOT**
  during steady inference.
- **Root cause:** kernel **6.17.x lacks the gfx1151 KFD/MES queue-management
  fixes** that landed upstream in kernel **6.18.4+**.
- **Fix:** upgrade the host kernel to **6.18.4+** (we are installing 6.18.36).

## Why it "worked well, then suddenly died"

The two modes have non-overlapping triggers, which explains the confusing
symptom timeline:

- The **illegal-opcode bug** is an *inference* bug. Fixed by moving to ROCm 7.2.4.
- The **MES suspend wedge** only fires when the driver **suspends/unloads GPU
  queues** — i.e. a **model swap**.

So while a single model (gpt-oss-120b) sat loaded and served steadily, the box was
rock-solid: no queue suspends, so no wedge. The **first model swap that forced an
eviction tripped the wedge** and took the GPU offline until reboot. "It was fine
all day and then died" is exactly the fingerprint of mode 2.

## Kernel rationale (why 6.18.4+ specifically)

- **Community consensus** for mid-2026 gfx1151 is **kernel 6.18.4+**. Known-good
  points: 6.18.6-6.18.14, the latest 6.18.x (6.18.36), or 6.19.x.
- **6.19.x** works but requires `HSA_OVERRIDE_GFX_VERSION=11.5.1` (which we set
  anyway).
- **Kernels `< 6.18.4` carry a documented gfx1151 stability bug.** We were on
  `6.17.12-061712-generic`, below that line — which is why the MES queue path was
  unfixed and the model-swap wedge was reachable.
- **Stale guidance to ignore:** the `pablo-ross/strix-halo-gmktec-evo-x2` repo
  recommends **kernel 6.16.9**. That is from the *memory-access era*, predates the
  6.18.4 stability fixes, and should **not** be followed for kernel choice.

## Operational caveat — the hardware watchdog does NOT reset the box

The SP5100 TCO watchdog is present (`/dev/watchdog`, `RuntimeWatchdogSec=60s`
armed) **but does not actually reset the machine.** It did **not fire during a
6-hour hard freeze.** The FCH watchdog reset is simply not wired on this mini-PC.

Consequences:

- **Auto-recovery is impossible.** Do not rely on the watchdog to bounce a wedged
  box.
- **PREVENTION is the only safety model.** Keep the known-good stack above; avoid
  the conditions that trigger either failure mode.
- **Recovery from a wedge is a manual reboot / power-cycle.** If a reboot stalls on
  amdgpu shutdown, force it with
  `echo s > /proc/sysrq-trigger; echo b > /proc/sysrq-trigger`.

## Anti-thrash mitigation — the "protect-resident" offload policy

Because **model swaps** are what trigger the wedge (mode 2), a routing policy was
designed to **avoid evicting a large resident model**:

- While a large model (**>= ~40 GB**, configurable) is resident locally and all
  slots are full, requests for *other* models that have a **viable remote backend**
  are **offloaded to remote** instead of evicting the big model.
- **Smaller models co-reside** when a slot is free.
- A model with **no remote backend always serves local** (correctness over
  wedge-avoidance).

This preserves multi-model serving while sidestepping the eviction that wedges the
GPU. It lives as a pure, unit-tested module at **`api/protect-resident.js`**.
Wiring it into the `server.js` routing path is **pending live verification**.

## Sources

- Framework Community — *"Linux + ROCm: January 2026 Stable Configurations"*:
  recommends kernel **6.18.4+**; known-good = kernel 6.18.5 / firmware 20260111 /
  ROCm 7.2.5.
  <https://community.frame.work/t/linux-rocm-january-2026-stable-configurations-update/79876>
- llm-tracker.info — Strix Halo: <https://llm-tracker.info/_TOORG/Strix-Halo>
- kyuz0/amd-strix-halo-toolboxes:
  <https://github.com/kyuz0/amd-strix-halo-toolboxes>
- ROCm issues for the MES / VPE / queue wedge class: #5665, #6165, #5590, #5745,
  #5724 — `https://github.com/ROCm/ROCm/issues/<n>`
- **Stale / do not follow for kernel choice:**
  `pablo-ross/strix-halo-gmktec-evo-x2` recommends kernel 6.16.9 (predates the
  6.18.4 fixes).

## Related

- [`docs/llama-cpp-rocm-build-and-deployment.md`](llama-cpp-rocm-build-and-deployment.md)
  — the ROCm 7.2.4 toolbox, engine deployment, and (optional) custom build.
- [`docs/GOTCHAS.md`](GOTCHAS.md) — hardware quirks with runnable fix scripts.
- `scripts/gpu-stability-setup.sh` — firmware / cmdline / watchdog hardening.
- `scripts/gpu-wedge-alert.sh` — standalone wedge-detection alerting (mode 2).
- Skill `system-health-monitor` — proactively watches the precursors to a lockup.
