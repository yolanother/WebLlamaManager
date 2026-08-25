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
| A renamed appliance is still reachable only at its OLD `<name>.local` address | `avahi-daemon` never notices a hostname change; ask it to re-announce with `systemctl --no-block try-restart avahi-daemon.service` | [`scripts/llama-manager-identity`](../scripts/llama-manager-identity) |
| Restarting `avahi-daemon` from a unit ordered `Before=` it wedges systemd and leaves avahi **stopped** | The restart job is ordered after the job waiting on it. Use `--no-block`, and bound the unit with `TimeoutStartSec=` | [`llama-manager-identity.service`](../llama-manager-identity.service) |
| A live USB forgets state written under the `writable` partition's mount point | casper bind-mounts that partition from a per-boot dated subdirectory. Mount it at its own root instead | [`scripts/llama-manager-identity`](../scripts/llama-manager-identity) |
| `node --test api/` hangs forever with no output (or dies with `ERR_MODULE_NOT_FOUND: express`), and stray `node api` processes pile up | The bare directory arg spawns `node api` → `api/server.js` → a **real server**. Run [`node --test api/*.test.js`](#node---test-api-boots-a-real-server-and-hangs-forever) instead | n/a — invocation |

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
podman exec llama-rocm-7.2.4 rocminfo | grep -E 'Marketing Name|gfx'
```

**Verify**

```bash
podman exec llama-rocm-7.2.4 rocminfo | grep -E 'Marketing Name|gfx'
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
podman exec llama-rocm-7.2.4 rocm-smi --showmeminfo all
```

GTT_Used should grow into the GB-range for a 7B+ model. With both this
fix and the NPU blacklist applied, a 27B Q4 model should produce
20-40 tok/s on Strix Halo.

---

## Working around local GPU outages while you wait for a reboot

When local GPU is broken (KFD wedged, ROCm down, etc.) the manager
automatically routes a request to a remote backend when the requested
name is an **alias group** with a reachable remote target — see
`config.aliases` and `config.json.backends.directory`. The
[`_llama_manager.compute`](#response-metadata) field tells callers
which path ran their request.

**To check status from a script or curl:**

```bash
curl -sS http://127.0.0.1:5250/api/health/gpu | jq
```

Returns:

```json
{
  "healthy": false,
  "kfd": "einval",
  "detail": "/dev/kfd open returned EINVAL — KFD state wedged. ...",
  "gpuBusyPercent": 0,
  "gpuVramUsedBytes": 163188736
}
```

When `kfd != "ok"`, the local accelerator is down and any local-only
model will fall back to CPU. Either reboot, or **add a remote target to
the affected model's alias group** so requests have somewhere healthy
to land:

```bash
# Give the model an alias group whose members are local FIRST, remote second.
# Local first keeps normal (healthy-GPU) behavior identical; while the GPU is
# wedged the local member is never resident, so the warm gate routes remote.
curl -sS -X PUT http://127.0.0.1:5250/api/aliases/Qwen_Qwen3-8B-GGUF \
  -H 'content-type: application/json' \
  -d '{"targets":[
        {"host":"local","model":"Qwen_Qwen3-8B-GGUF"},
        {"host":"borethrax-ollama-mnfmirep","model":"qwen3-vl:8b"}]}'

# Confirm which members are warm right now:
curl -sS http://127.0.0.1:5250/api/aliases | jq '.aliases[] | {name, warm, cold}'
```

Naming the alias after the local model is intentional here — an alias
**shadows** a real model of the same name, so existing clients need no
change. Keeping the local target first is what preserves local serving;
see [`features/model-alias-groups.md`](features/model-alias-groups.md).

The old per-backend `modelMapping` field still works for this through a
**deprecated** compatibility shim on `GET`/`PUT /api/backends` (it is
synthesized from, and folded back into, the alias table), but it cannot
express a local target or a multi-host group. Use `/api/aliases`.

### Response metadata

Every `/api/v1/chat/completions`, `/api/v1/messages`, and `/api/v1/responses`
reply carries an `_llama_manager` block so the caller can detect
slow-path runs without polling another endpoint:

```json
"_llama_manager": {
  "duration": 3843,
  "tokensPerSecond": 47.0,
  "backend": "dahaka-ollama-mngx88pk",
  "compute": "remote",      // local-gpu | local-cpu | local-unknown | remote
  "slow": false,            // true when tokensPerSecond < 1
  "warning": "Sub-1 tok/s …" // present only when slow=true
}
```

Callers should treat `slow: true` as an alarm signal — the request
almost certainly ran on CPU. Dashboards can surface it directly.

---

## `node --test api/` boots a real server and hangs forever

**Affects:** anyone (human or agent) running the API test suite in this
repo, in the primary checkout or in a git worktree.

**Symptom**

- `node --test api/` never returns. No test output, no failure — it
  just sits there.
- Or, in a fresh worktree, it fails immediately with something that
  looks like a broken test but is not:
  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'
  ```
- Afterwards, orphan processes are left behind:
  ```
  $ ps -eo pid,args | grep "node api"
  1234567 node api
  ```
- Symptoms of a second llama-manager: port-bind errors, a config file
  written by a process you did not start, unexplained model loads.

**Why**

Node treats the bare directory argument as a **test file**, so it spawns
`node api`. Node resolves that directory to its entry point,
`api/server.js`, and **starts an actual llama-manager server** — which
by design never exits. The test runner then waits on a "test file" that
is really a running server.

The `ERR_MODULE_NOT_FOUND` variant is the same bug wearing a disguise:
a fresh worktree has no `api/node_modules`, so the server fails to
import `express` while starting. It is the server failing to boot, not
a test failing.

This cost two agent sessions roughly 40 minutes and left three orphan
servers running on a box with a documented history of OOM and thermal
lockups — an extra unattended `llama-server` parent is not harmless
here.

**Fix**

Always glob the test files explicitly:

```bash
node --test api/*.test.js       # 601 tests, ~350 ms
cd ui && npm test               # 86 tests
cd ui && npm run build
```

Never `node --test api/`, and never `node --test` on any directory in
this repo.

In a fresh worktree, link the dependencies first — tests that import
server code need them:

```bash
ln -s /home/yolan/workspace/ai/llama-server/api/node_modules \
      /path/to/worktree/api/node_modules
cd /path/to/worktree/ui && npm install    # ui tests need their own tree
```

Note also that `./scripts/dev-build.sh check` **does not exist** in this
repo — it is an orchestrator-template convention. The real gate is the
node test suite above plus the ui build.

**Recovery**

```bash
ps -eo pid,args | grep "node api"     # find strays
kill <pid>
```

> ⚠️ **Never kill whatever holds port 5250** — that is the live dev
> server. Check before killing anything:
> ```bash
> ss -lptn 'sport = :5250'
> ```

**Verify**

`node --test api/*.test.js` completes in well under a second and prints
a pass/fail summary. `ps -eo pid,args | grep "node api"` returns
nothing afterwards.

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

---

## Node identity: three things that only fail on real media

**Affects:** any appliance that publishes itself over mDNS — see
[Zero-configuration node identity](Designs/NodeIdentity.md).

All three passed a green test suite and failed on a booted appliance.

### avahi-daemon does not notice a hostname change

`hostnamectl set-hostname` changes the hostname, `/etc/hostname`, and the kernel
node name, and `avahi-daemon` keeps answering for the name it started with. A
renamed box was reachable at its **old** `.local` address and never at its new
one — which is the entire feature, silently absent, with every local check
passing.

avahi re-reads the system hostname at startup, so the fix is to ask it to
re-announce:

```bash
systemctl --no-block try-restart avahi-daemon.service
```

`try-restart` rather than `restart` so it is a no-op at boot, where identity is
applied before avahi has started and avahi reads the correct hostname by itself.

### A blocking restart of avahi from a unit ordered before it deadlocks systemd

`llama-manager-identity.service` is `Before=avahi-daemon.service`. Calling
`systemctl try-restart avahi-daemon.service` from inside it asks systemd for a
job that is ordered *after* the job currently waiting on that call. The
transaction deadlocks, the unit times out, and **avahi is left stopped** — the
box then has no mDNS at all, which is far worse than the stale name the call
exists to fix.

Symptom, once it has happened:

```
$ systemctl list-jobs
26607 llama-manager-identity.service start running
26692 avahi-daemon.service           start waiting
```

Recover by killing the wedged `systemctl` and script processes; the jobs then
drain. Avoid it with `--no-block`, and give the unit a `TimeoutStartSec=` so a
resolver that ever wedges cannot hold avahi hostage indefinitely.

### The `writable` partition is not mounted where you would write to it

`findmnt LABEL=writable` reports a mount point — `/var/log` on current media —
but casper bind-mounts the partition there from a subdirectory named for the boot
date:

```
$ findmnt -o SOURCE,TARGET | grep writable
/dev/disk/by-label/writable[/install-logs-2026-08-25.0/log]   /var/log
/dev/disk/by-label/writable[/install-logs-2026-08-25.0/crash] /var/crash
```

Anything written through those paths lands in a directory the **next** boot does
not look at, so live-USB state is forgotten on exactly the reboot it exists to
survive — and it looks perfectly persistent until you actually reboot.

Mount the labelled partition at its own root for the moment you need it:

```bash
mkdir -p /run/llama-manager/writable
mount /dev/disk/by-label/writable /run/llama-manager/writable
# ... read/write /run/llama-manager/writable/<your state> ...
umount /run/llama-manager/writable
```
