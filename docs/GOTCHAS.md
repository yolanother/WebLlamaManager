# Gotchas & Hardware Quirks

Real problems we've hit and how we fixed them. The fixes are documented
here (and as runnable scripts under `scripts/`) so the next person —
or the next AMD/ROCm release — doesn't have to rediscover them.

When you hit a new one: add an entry below, drop a script under
`scripts/`, and link it from the [Quick Index](#quick-index).

## Quick Index

| Symptom | Fix | Script |
|---|---|---|
| llama.cpp on Strix Halo logs `failed to initialize ROCm: no ROCm-capable device is detected`; tok/s < 1 even on small models; `rocminfo` says `Unable to open /dev/kfd read-write: Invalid argument` | Blacklist the `amdxdna` NPU driver — it claims `/dev/kfd` before `amdgpu` can | [`scripts/fix-strix-halo-npu-conflict.sh`](../scripts/fix-strix-halo-npu-conflict.sh) |
| `/dev/kfd` permissions look fine but container `rocminfo` returns EINVAL anyway | Full `amdgpu` reload (or host reboot) — the in-kernel KFD state is wedged | [`scripts/fix-gpu-passthrough.sh`](../scripts/fix-gpu-passthrough.sh) |
| Model loaded but only a few hundred MB land in GTT; HIP backend logs `cudaMalloc failed` on Strix Halo for models larger than the BIOS-reserved VRAM partition | Export `GGML_HIP_UMA=1` and `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` before launching `llama-server` (already wired into `container-start.sh`) | n/a — config |

---

## Strix Halo: `amdxdna` NPU vs `amdgpu` KFD conflict

**Affects:** AMD Strix Halo / Ryzen AI MAX (gfx1151 iGPU) on Linux kernels that
ship the in-tree `amdxdna` NPU driver.

**Symptom**

- llama.cpp on first model load:
  ```
  ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device is detected
  load_tensors:          CPU model buffer size = ... MiB
  load_tensors:   CPU_REPACK model buffer size = ... MiB
  ```
- `rocminfo` (host or container):
  ```
  ROCk module is loaded
  Unable to open /dev/kfd read-write: Invalid argument
  ```
- `cat /sys/class/drm/card*/device/gpu_busy_percent` stays at `0` even
  during prompt processing.
- Token rate <1 tok/s on a 27B Q4 model that should do 20-40 tok/s on
  the iGPU.

**Why**

On Strix Halo systems both `amdxdna` (NPU compute) and `amdgpu`'s KFD path
expose themselves through `/dev/kfd`. If `amdxdna` loads first or at all
on some kernels, ROCm's `open("/dev/kfd", O_RDWR)` returns `EINVAL` and
HIP/ROCm cannot see the iGPU. The container shows the device with mode
`0666` so it's not a permissions problem — `chmod`/group fiddling will
not help.

**Fix**

Persistently blacklist `amdxdna`, then **reboot** — not just `modprobe -r`:

```bash
echo "blacklist amdxdna" | sudo tee /etc/modprobe.d/blacklist-amdxdna.conf
sudo reboot   # mandatory if amdxdna ever co-loaded with amdgpu
```

The wrapper script does the blacklist + unload + service restart and
checks for you:

```bash
./scripts/fix-strix-halo-npu-conflict.sh
```

> ⚠️ **You almost certainly still need a reboot the first time.**
> Unloading `amdxdna` does NOT unwind the broken KFD state in
> `amdgpu`. As long as the host shows
> `python3 -c "import os; os.open('/dev/kfd', os.O_RDWR)"` → `errno=22`
> the only cures are:
>
> 1. **Reboot** (recommended — the blacklist file keeps `amdxdna`
>    out, so a clean `amdgpu` initializes alone).
> 2. Full `amdgpu` reload via [`fix-gpu-passthrough.sh`](../scripts/fix-gpu-passthrough.sh)
>    — risky, will kill any running display/X/Wayland session and any
>    GPU-using process. Only attempt from a TTY with the desktop
>    stopped.
>
> If `modprobe -r amdxdna` fails with "Module is in use", that means
> something is still holding /dev/accel open — reboot is the only fix.

After the reboot:

```bash
lsmod | grep amdxdna                              # should be empty
python3 -c "import os; os.open('/dev/kfd', os.O_RDWR)"  # should succeed
podman exec llama-rocm-7rc-rocwmma rocminfo | grep -E 'Marketing Name|gfx'
```

**Verify**

```bash
podman exec llama-rocm-7rc-rocwmma rocminfo | grep -E 'Marketing Name|gfx'
# Should print: gfx1151 (or similar) and the Radeon marketing name.

watch -n1 'cat /sys/class/drm/card*/device/gpu_busy_percent'
# Send a chat request; busy% should ramp into the tens-of-percent during
# prompt processing and generation.
```

**Status:** Permanent fix as long as the blacklist file stays in place.
Re-verify after any `amdxdna` kernel-module update or distro upgrade.

---

## Strix Halo: stale KFD state needs full driver reload

**Affects:** Same hardware, but after some unclean shutdowns of ROCm
processes or after `amdxdna` was previously loaded and you blacklisted
it without rebooting.

**Symptom**

`amdxdna` is no longer loaded, `/dev/kfd` permissions look fine, the
container has `--privileged` plus `render`/`video` groups, but
`rocminfo` still returns `Unable to open /dev/kfd read-write: Invalid argument`.

**Why**

The KFD interface in `amdgpu` keeps process-bound state. If a previous
ROCm process exited badly (or `amdxdna` registered itself first) that
state is wedged until the driver fully reloads. Permissions, group
membership and container privileges are red herrings here.

**Fix**

Use the existing recovery script which stops everything touching the
GPU, removes and re-inserts `amdgpu`, and verifies before re-starting
the manager:

```bash
./scripts/fix-gpu-passthrough.sh
```

If that fails (modules in use by display, X / Wayland session, etc.),
reboot the host — that is the only guaranteed cure.

**Verify**

Same as above — `rocminfo` should list the GPU and a chat request
should drive `gpu_busy_percent` non-zero.

---

## Strix Halo: HIP backend ignores unified memory by default

**Affects:** Strix Halo / Ryzen AI MAX iGPU running `llama-server` built
with the HIP backend, when the target model is larger than the BIOS-
reserved VRAM partition (typically 1-16 GB depending on UEFI setting).

**Symptom**

- `rocm-smi --showmeminfo all` reports VRAM_Total ~1 GB, VRAM_Used a few
  hundred MB, GTT_Total ~half of system RAM, GTT_Used near zero.
- llama-server load fails with `cudaMalloc failed: out of memory` or
  similar even though plenty of system RAM is free.
- Or it appears to "succeed" but quietly keeps tensors on CPU.

**Why**

Without explicit opt-in, llama.cpp's HIP backend only allocates from
dedicated VRAM. On unified-memory APUs that VRAM partition is tiny,
so anything non-trivial gets rejected. The fix is to allow allocations
to spill into GTT (Graphics Translation Table) — system RAM that the
iGPU can address directly.

**Fix**

Export both env vars before `llama-server` starts (the canonical name
changed between llama.cpp releases; setting both is harmless):

```bash
export GGML_HIP_UMA=1
export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1
```

This is already baked into `container-start.sh`. If you launch
`llama-server` by another path, set these yourself.

**Verify**

After loading a model larger than VRAM:

```bash
podman exec llama-rocm-7rc-rocwmma rocm-smi --showmeminfo all
```

GTT_Used should grow into the GB-range for a 7B+ model. With both this
fix and the NPU blacklist applied, a 27B Q4 model should produce
20-40 tok/s on Strix Halo.

---

## Reporting a new gotcha

When you hit something painful:

1. Write a fix script under `scripts/` and make it idempotent.
2. Add a new entry above with: **Affects**, **Symptom**, **Why**,
   **Fix**, **Verify**.
3. Update the [Quick Index](#quick-index) row at the top.
4. Reference it from a one-line bullet in the main `README.md`
   *Troubleshooting* section.

If the gotcha is about a hardware/kernel combo that isn't yours, label
it clearly under **Affects** so other users know whether it applies.
