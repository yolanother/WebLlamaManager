# Laya DECISION Engine (W6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** llama-manager supervises a digest-pinned `laya-server` Podman container as a lazily started `DECISION` engine on :5254. It proxies Jev-wire `POST /v1/systemone` with an `x-laya-host` header. Frostburn routes the `laya` alias to drakemore first, then to its own local engine when memory allows, and otherwise returns 503. The feature ships in the appliance ISO and is deployed to both boxes.

**Architecture:**

- **Pure policy** lives in `api/decision.js`: config, image pin check, `podman run` argv, model filter, peer route planning and fleet advertisement.
- **Supervisor** is `api/decision-supervisor.js`. It is a dependency-injected lazy-start/idle-stop state machine, modelled on `api/ds4-supervisor.js`.
- **Routes** are in `api/decision-router.js`, an Express router factory. It follows the `createMediaRouter` pattern, so it can be tested without booting `server.js`.
- **`server.js`** only wires these modules to live state: `config`, `saveConfig`, `memAvailableBytes`, `lastKnownPeers`, `describeNodeIdentity` and `isLoopbackRequest`.

**Tech Stack:** Node ≥20 ESM, Express 4, `node:test` + `node:assert/strict`, rootless Podman, React 18 (Dashboard card), bash (`tests/*/run-tests.sh`), and the Debian respin submodule `distribution/ubuntu-respin`.

**Spec:** orchestrator repo `docs/superpowers/specs/2026-09-22-system1-decision-provider-design.md` (§3 Laya facts, §4.5 hosting). The contract is in master plan `docs/superpowers/plans/2026-09-22-system1-master-plan.md` §1.5 and the §2 W6 row.

## Global Constraints

- **Repo:** `~/workspace/ai/llama-server` (github `yolanother/WebLlamaManager`). Its `main` is Frostburn's live dev server.
  - Implement in a worktree: `git worktree add .claude/worktrees/laya-decision -b laya-decision`.
  - Land only through `~/bin/llama-land-and-deploy.sh <sha…>`, which wraps `.orchestrator/scripts/worktree-merge.sh`. Never use a bare push.
- **Engine and config:**
  - Engine type `DECISION` (`ENGINE_TYPES.DECISION = 'decision'`).
  - Config block `decision: { enabled, image, checkpoint, gpu, port: 5254, idleTimeoutSec }`.
  - The default is `enabled: false`.
- **Endpoints:** `POST /v1/systemone`, `POST /api/v1/systemone` (model `laya` | `laya-*` | `jev-*`, or omitted) and `GET /api/decision/status`.
  - Every response sets `x-laya-host: <node-name>`.
- **Frostburn alias order:**
  1. drakemore DECISION, when healthy
  2. local DECISION, when the memory guard is OK (lazy start)
  3. otherwise 503 `{"error":"no_decision_host"}`
- **Image:** pinned by digest (`…@sha256:<64 hex>`) or by full image id (`sha256:<64 hex>`). An unpinned image is refused with `runnable:false`.
- **Weights cache:**
  - packaged: `/var/lib/llama-manager/decision`
  - source: `<repo>/data/decision` (gitignored by `data/`)
  - Both are resolved through `api/runtime-paths.js`.
- **Files and tests:**
  - Every new file starts with the repo header: `// Llama Manager — <what>.` + `// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.` + a self-contained purpose paragraph.
  - Every export has JSDoc.
  - Tests are `api/<module>.test.js` with `node:test`. Run them as `node --test api/<file>.test.js`, or the full gate `node --test api/*.test.js`.
  - **Never** run `node --test api/` (it boots a real server and hangs).
  - The UI gate is `cd ui && npm test`.
  - Known external failures: 2 in `api/dev-config.test.js`.
- **TDD:** write the test, watch it fail, implement, watch it pass, commit. Record red→green in the W6 task via `orch tasks progress`, and `orch tasks add-diff <taskId> <sha> "<title>"` every commit.
- **Commits:**
  - Write the message to `LastChange.md` and run `git commit -F LastChange.md`.
  - End the message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Use `git commit --no-verify` only if the known pre-commit fork-bomb hook fires.
- **Maintainer scripts** in the respin must never contain `curl|wget|npm|pip|git clone|podman pull` (`distribution/ubuntu-respin/tests/test-maintainer-scripts.sh:39`).
- **Remote access:** drakemore is reached only through `ssh drakemore` / `~/bin/drakemore` (strict host keys). Never use `StrictHostKeyChecking=no`. Frostburn is the local host; do not ssh to it.

## Spike-dependent values (filled by T0, never guessed)

| Symbol | Where it lands | Rule for filling |
|---|---|---|
| `<LAYA_SERVER_SHA>` | T0 build command and the T5 asset row | `git -C ~/src/laya-server rev-parse HEAD` at clone time |
| `<DECISION_IMAGE>` | `DEFAULT_DECISION_IMAGE` in `api/decision.js` (T1) | Registry path: `ghcr.io/yolanother/laya-server@sha256:<repo digest>` from `podman push --digestfile`. OCI-tar path: `sha256:<image id>` from `podman image inspect --format '{{.Id}}'` |
| `<VARIANT>` | the T0 decision record | `rocm` or `cuda`, per the T0 decision rule |
| `<PODMAN_GPU_ARGS>` | `DEFAULT_DECISION_PODMAN_ARGS` in `api/decision.js` (T1) | The exact device/group flags of the winning T0 run |
| `<DEVICE>` | `DEFAULT_DECISION_DEVICE` (T1) | `LAYA_SERVER_DEVICE` value from the winning run (`cuda:0` on ROCm too, since torch-ROCm exposes HIP as `cuda`) |
| `<GPU_POOL>` | `decision.gpu` in the T6 deploy config | The `config.gpus[].id` of the pool containing the winning card on drakemore (`curl -s localhost:3001/api/gpus`). Empty on Frostburn |
| `<MIN_FREE_BYTES>` | `DECISION_DEFAULTS.minFreeMemBytes` (T1) | 2 × the measured peak (container RSS + GPU memory) from T0 step 7, rounded up to a whole GiB. Floor 4 GiB |
| `<IMAGE_BYTES>` | T5 branch choice | `podman image inspect --format '{{.Size}}'` of the winning image |

---

## AMENDMENTS (2026-09-22, coordinator; BINDING — override the tasks below where they differ)

Operator rules and W6-T0 spike results (orch task T316bcaa0b5805):

- **A1 Frostburn builds everything.** Nothing is built on drakemore. There is no `podman build` or `pip` there, ever.
  drakemore can be reimaged from Frostburn's ISO at any time, so the engine must arrive via deb/ISO/APT.
  T0 steps 4–6 as written (building and running on drakemore) are **void**. The spike ran on Frostburn, which has the same
  gfx1151 iGPU.
- **A2 ROCm (gfx1151) is the default and only v1 variant.** The CUDA 3090 is overloaded. A GPU selector plus a CUDA variant is
  follow-up T316bce193f81c. Winning values:
  - `LAYA_SERVER_DEVICE=cuda:0`
  - `HSA_OVERRIDE_GFX_VERSION=11.5.1`
  - devices `--device /dev/kfd --device /dev/dri --group-add keep-groups --security-opt seccomp=unconfined`
- **A3 Our own pinned Containerfile.** It lives at `packaging/decision/Containerfile` in this repo and builds laya-server @
  `819fa065dce72b3c117a2364bb4839c02a0abcb3`.
  - Upstream's ROCm image is broken: `ImportError: libatomic.so.1`. The Containerfile must
    `apt-get install -y --no-install-recommends libatomic1`.
  - To shrink the image, strip every non-gfx1151 kernel file from `torch/lib/hipblaslt/library` and
    `torch/lib/rocblas/library`. Keep `*fallback*`, `TensileManifest.txt`, and all `gfx1151` files.
    Measured before stripping: 16.18 GB image, 6.30 GB zstd archive. The target is ≈4 GB compressed.
  - Base images are pinned by digest.
- **A4 Shipping follows the `llama-manager-rocm-gfx1151` precedent exactly.**
  - A pinned `oci-image` row in `distribution/ubuntu-respin/assets.lock`, archive in the NAS asset mirror
    `/volumes/llama-manager/assets/laya/`.
  - A new split deb `llama-manager-laya-rocm` carrying `/usr/lib/llama-manager/offline/laya-server.oci.tar`.
  - Its postinst runs `run_manager podman load` plus an image-ID check (copy `debian/llama-manager-rocm-gfx1151.postinst:39-59`).
  - Add it to the appliance `Depends` and to the loop in `tests/test-maintainer-scripts.sh`.
  - The zstd archive must stay < 9 GB (dpkg ar member limit).
  - The operator was asked about the size (orch question X-vaLtPSr_G4vT1MiFtxj). The coordinator default is "strip, then ship via deb".
- **A5 `DEFAULT_DECISION_IMAGE`** is the image ID (`sha256:<64 hex>`) loaded from that archive. It is not a registry reference,
  and there is no ghcr push.
- **A6 Model mapping.** laya-server routes the model name `laya` to `laya-english` (HTTP 422 when that checkpoint isn't loaded).
  llama-manager must rewrite `model` to `laya-typed-decisions` for `laya`, `laya-*` (unless it names a loaded checkpoint) and
  `jev-*` before proxying.
- **A7** `/v1/systemone` responses also carry `"host": "<node-name>"` in the JSON body, because node-proxy drops headers
  (orchestrator master plan R27).
- **A8 Measured on Frostburn while busy:**
  - p50: 1 question 94.5 ms, 5 questions 206.7 ms, 10 questions 332.3 ms (≈25 ms per extra question)
  - RSS 2.7 GB, VRAM 1.68 GB, first weight load 46 s
  - `DECISION_DEFAULTS.minFreeMemBytes` = **6 GiB**
  - laya-server serializes requests (global lock).
- **A9 Deploying to drakemore** (T6) means installing the built deb from Frostburn (`scp` the deb, then `apt install ./…deb`,
  or through the release APT repo). The `api/*.js` hot-patch is fine for code iteration, but the image only ever arrives via the deb.
- **A10** `LastChange.md` is a **tracked** file in this repo. Write commit messages to a scratch file outside the repo and
  run `git commit -F <that file>`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `api/decision.js` | create | Pure policy: config resolution, pin check, podman argv, model filter, peer planning, advertisement, config patch whitelist |
| `api/decision.test.js` | create | Unit tests for the above |
| `api/decision-supervisor.js` | create | Lazy start, health wait, idle stop and stale-container cleanup for the one container |
| `api/decision-supervisor.test.js` | create | State-machine tests with fake spawn/fetch/timers |
| `api/decision-router.js` | create | Express router: `/v1/systemone`, `/api/v1/systemone`, `/api/decision/{status,start,stop,config}` |
| `api/decision-router.test.js` | create | Route tests via a fake `expressImpl` |
| `api/runtime-paths.js` / `.test.js` | modify | Add `decisionDir` |
| `api/engines.js` / `engines.test.js` | modify | `ENGINE_TYPES.DECISION`; optional `decision` registry entry |
| `api/server.js` | modify | Wiring: supervisor, router mount, stats registry, fleet advertisement, shutdown |
| `ui/src/pages/decision-card.js` / `.test.js` | create | Pure helper choosing the card's Start/Stop action |
| `ui/src/pages/Dashboard.jsx` | modify | Decision icon plus Start/Stop button on the registry card |
| `packaging/llama-manager.tmpfiles` | modify | `d /var/lib/llama-manager/decision` |
| `scripts/decision-bench.mjs` | create (T0) | Latency bench used by the spike and the smoke tests |
| `scripts/decision-enable.sh` | create (T6) | Scripted, persistent enable through the loopback config API |
| `tests/decision/run-tests.sh` | create (T6) | Shell test for `decision-enable.sh --print` |
| `docs/features/decision-engine.md` | create (T6) | Operator doc |
| `distribution/ubuntu-respin/…` | modify only on the T5 preload branch | OCI-tar preload |

---

### Task 0: Spike on drakemore and Frostburn (CUDA 3090 vs ROCm gfx1151, memory headroom)

**Files:**
- Create: `scripts/decision-bench.mjs`
- Record: the W6-T0 orch task (progress note with the table below). No other repo change.

**Interfaces:**
- Produces all the spike-dependent values in the table above.

**Known facts going in (verified 2026-09-22, re-check each):**
- **laya-server publishes no image** (CI only runs `docker compose up --build`). We build it ourselves.
  - `Dockerfile`: `python:3.13-slim` with `ARG TORCH_INDEX` (`cpu`, `cu130`, `rocm7.2`) and `TORCH_VERSION=2.14.0`.
  - The container listens on **8765** and runs as uid 1000 (`laya`).
  - Weights are cached under `HF_HOME=/data/huggingface` (`VOLUME /data`).
  - Env vars: `LAYA_SERVER_MODELS` (`english|multilingual|typed-decisions`), `LAYA_SERVER_JEV_ALIAS=1`, `LAYA_SERVER_DEVICE`.
  - It serves one request at a time (global lock). `/healthz` answers only after the weights load.
- **laya-server's default device choice skips integrated GPUs.** Strix Halo is an iGPU, so ROCm runs must set `LAYA_SERVER_DEVICE=cuda:0` explicitly, or they silently run on CPU.
- **Drakemore's RTX 3090 runs the NVIDIA *open* kernel module 610.43.02 with `nvidia_uvm`** (`docs/Designs/GpuReservations.md:395-398`).
  - It does **not** run on nouveau. Nouveau is blacklisted only for GB10.
  - No `nvidia-container-toolkit`/CDI exists anywhere in the appliance, so a CUDA container needs a manual device + driver-library bind for this spike.
  - Productizing CUDA would need a respin change (see the decision rule).
- **torch ROCm wheels and gfx1151:** pytorch.org `rocm7.2` wheels are not on AMD's gfx1151 support matrix, and community reports show segfaults. AMD's wheels (`https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/`) are the documented fallback. `HSA_OVERRIDE_GFX_VERSION=11.0.0` is the last resort.

- [ ] **Step 1: Write the bench tool**

```js
#!/usr/bin/env node
// Llama Manager — System 1 decision engine latency bench.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Measures end-to-end latency of a Jev-wire POST /v1/systemone endpoint (a raw
// laya-server container, or llama-manager's proxy) for 1, 5 and 10 `noul`
// questions per request, and prints p50/p95 per size plus the x-laya-host that
// served the calls. Used by the W6 spike (CUDA vs ROCm, Frostburn headroom) and
// by the deploy smoke tests. Node builtins only.
//
// Usage: node scripts/decision-bench.mjs <base-url> [iterations=20] [model=laya]

const [base, iterArg = '20', model = 'laya'] = process.argv.slice(2);
if (!base) { console.error('usage: decision-bench.mjs <base-url> [iterations] [model]'); process.exit(2); }
const iterations = Number(iterArg);
const state = 'Invoice INV-2291 from Acme Ltd, total NZD 4,120.00, due 2026-10-01. '.repeat(8);

/** p-th percentile (0..100) of a numeric array (nearest-rank). */
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

for (const n of [1, 5, 10]) {
  const questions = Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`q${i}`, { type: 'noul', instructions: `Is statement ${i} about an invoice?` }]));
  const times = [];
  let host = '';
  for (let i = 0; i < iterations + 1; i++) {
    const t0 = performance.now();
    const r = await fetch(`${base.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
    });
    const body = await r.json();
    if (!r.ok) { console.error(`HTTP ${r.status}`, body); process.exit(1); }
    host = r.headers.get('x-laya-host') || host;
    if (i > 0) times.push(performance.now() - t0); // first call is warm-up
  }
  console.log(`questions=${n} p50=${percentile(times, 50).toFixed(1)}ms p95=${percentile(times, 95).toFixed(1)}ms host=${host || '-'}`);
}
```

Run: `node --check scripts/decision-bench.mjs`
Expected: no output, exit 0.

- [ ] **Step 2: Commit the bench**

```bash
git add scripts/decision-bench.mjs
git commit -F LastChange.md   # "feat(decision): add laya latency bench for the W6 spike"
```

- [ ] **Step 3: Probe drakemore's GPU runtimes (read-only)**

```bash
drakemore ssh 'nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv; ls -l /dev/nvidia* 2>&1; ls /usr/lib/x86_64-linux-gnu/libcuda.so* /usr/lib/x86_64-linux-gnu/libnvidia-ml.so* 2>&1; command -v nvidia-ctk || echo NO_NVIDIA_CTK'
drakemore ssh 'ls -l /dev/kfd /dev/dri/render*; id llama-manager; podman --version; runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman info --format "{{.Host.Security.Rootless}} {{.Store.GraphRoot}}"'
drakemore ssh 'free -b; curl -s localhost:3001/api/gpus'
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.79:3001/api/v1/models   # Frostburn → drakemore reachability over LAN
```

Record:

- `nvidia-smi` presence and driver version
- whether `libcuda.so.1` exists on the host
- whether `nvidia-ctk` exists
- render/video group membership of `llama-manager`
- whether rootless podman reports `true`
- MemAvailable
- the `/api/gpus` pool ids
- the LAN HTTP code (it must be `200`; otherwise T3's peer URL needs another route, so stop and ask)

- [ ] **Step 4: Build both images on Frostburn**

The build runs on Frostburn because it has the build cache and network.

```bash
git clone https://github.com/noahbclarkson/laya-server ~/src/laya-server
git -C ~/src/laya-server rev-parse HEAD            # → <LAYA_SERVER_SHA>
podman build -t localhost/laya-server:rocm --build-arg TORCH_INDEX=rocm7.2 ~/src/laya-server
podman build -t localhost/laya-server:cuda --build-arg TORCH_INDEX=cu130   ~/src/laya-server
podman image inspect --format '{{.Id}} {{.Size}}' localhost/laya-server:rocm localhost/laya-server:cuda
```

Record both image ids and sizes.

- [ ] **Step 5: Ship both images to drakemore's service-account store**

```bash
podman save --format oci-archive -o /tmp/laya-rocm.tar localhost/laya-server:rocm
podman save --format oci-archive -o /tmp/laya-cuda.tar localhost/laya-server:cuda
scp /tmp/laya-rocm.tar /tmp/laya-cuda.tar drakemore:/var/tmp/
drakemore ssh 'for f in rocm cuda; do runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman load -i /var/tmp/laya-$f.tar; done'
drakemore ssh 'install -d -o llama-manager -g llama-manager -m 2770 /var/lib/llama-manager/decision'
```

- [ ] **Step 6: Run and bench each variant**

Run ROCm first. Use port 5254, the same port T1 will use. Define the runner once per session in a local helper file so no quoting tricks are needed.

```bash
cat > /tmp/laya-run.sh <<'EOF'
#!/bin/bash
# usage: laya-run.sh <image> <extra podman args...>
set -euo pipefail
img="$1"; shift
runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager \
  podman run -d --rm --name laya-spike --userns=keep-id:uid=1000,gid=1000 \
  -p 127.0.0.1:5254:8765 -v /var/lib/llama-manager/decision:/data \
  -e LAYA_SERVER_MODELS=typed-decisions -e LAYA_SERVER_JEV_ALIAS=1 "$@" "$img"
EOF
scp /tmp/laya-run.sh drakemore:/var/tmp/laya-run.sh
scp scripts/decision-bench.mjs drakemore:/var/tmp/decision-bench.mjs
```

Try ROCm variants **in this order** and stop at the first one whose `/healthz` reports `"device":"cuda:0"` and whose bench completes.

```bash
# R1 stock wheel, native gfx1151
drakemore ssh 'bash /var/tmp/laya-run.sh localhost/laya-server:rocm --device /dev/kfd --device /dev/dri --group-add keep-groups --security-opt seccomp=unconfined -e LAYA_SERVER_DEVICE=cuda:0 -e HSA_OVERRIDE_GFX_VERSION=11.5.1'
drakemore ssh 'for i in $(seq 1 120); do curl -sf localhost:5254/healthz && break; sleep 5; done; echo; runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman logs --tail 30 laya-spike'
drakemore ssh '/usr/lib/llama-manager/node/bin/node /var/tmp/decision-bench.mjs http://127.0.0.1:5254 20'
drakemore ssh 'runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman stop laya-spike'
# R2 same image with -e HSA_OVERRIDE_GFX_VERSION=11.0.0 (repeat the 4 commands above)
# R3 AMD wheels: only if R1+R2 fail. Build on Frostburn from this Containerfile, then repeat steps 5-6:
```

If R3 is needed, write `~/src/laya-server-amd/Containerfile` (spike-local, not committed here):

```dockerfile
FROM localhost/laya-server:rocm
USER root
RUN pip uninstall -y torch && pip install --no-cache-dir torch --index-url https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/
USER laya
```

```bash
podman build -t localhost/laya-server:rocm-amd ~/src/laya-server-amd
```

CUDA run on the 3090. Without CDI, bind the device nodes and the driver libraries by hand:

```bash
drakemore ssh 'bash /var/tmp/laya-run.sh localhost/laya-server:cuda --device /dev/nvidia0 --device /dev/nvidiactl --device /dev/nvidia-uvm --device /dev/nvidia-uvm-tools --group-add keep-groups -v /usr/lib/x86_64-linux-gnu/libcuda.so.1:/usr/lib/x86_64-linux-gnu/libcuda.so.1:ro -v /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:ro -e LAYA_SERVER_DEVICE=cuda:0'
# then the same healthz / bench / stop commands as R1
```

If `/dev/nvidia0` is a different index (for example `/dev/nvidia1`), use the index `nvidia-smi` reports. If `libcuda.so.1` is absent on the host, record `CUDA: not runnable without driver userland` and skip the CUDA run.

- [ ] **Step 7: Measure the footprint while the winning variant is running (both hosts)**

On drakemore, during a 10-question bench loop:

```bash
drakemore ssh 'runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman stats --no-stream --format "{{.MemUsage}}" laya-spike; curl -s localhost:5254/healthz; nvidia-smi --query-gpu=memory.used --format=csv 2>/dev/null; curl -s localhost:3001/api/stats | head -c 600'
```

Coexistence check: run `drakemore models`, then send one chat completion to the resident model while the bench runs:

```bash
drakemore ssh 'curl -s -o /dev/null -w "%{http_code} %{time_total}\n" localhost:3001/v1/chat/completions -H "content-type: application/json" -d "{\"model\":\"<a model id from drakemore models>\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":8}"'
```

On Frostburn (local), run the ROCm winner the same way, but as user `yolan`, with the source-mode cache dir `~/workspace/ai/llama-server/data/decision` and no `runuser`:

```bash
mkdir -p ~/workspace/ai/llama-server/data/decision
podman run -d --rm --name laya-spike --userns=keep-id:uid=1000,gid=1000 -p 127.0.0.1:5254:8765 -v ~/workspace/ai/llama-server/data/decision:/data -e LAYA_SERVER_MODELS=typed-decisions -e LAYA_SERVER_JEV_ALIAS=1 --device /dev/kfd --device /dev/dri --group-add keep-groups --security-opt seccomp=unconfined -e LAYA_SERVER_DEVICE=cuda:0 -e HSA_OVERRIDE_GFX_VERSION=<winning value> localhost/laya-server:<winning rocm tag>
node scripts/decision-bench.mjs http://127.0.0.1:5254 20
grep MemAvailable /proc/meminfo; podman stats --no-stream --format '{{.MemUsage}}' laya-spike; curl -s localhost:5254/healthz
podman stop laya-spike
```

Also record Frostburn's MemAvailable at its **busiest** normal state: while its default-big model is resident, run `curl -s localhost:5250/api/stats`.

- [ ] **Step 8: Apply the decision rule and record it**

**Variant:**
- Choose **ROCm gfx1151** when three things hold:
  - it runs on `cuda:0`, not CPU;
  - p50 for 10 questions is ≤ 300 ms;
  - the coexistence chat call still returns 200.
- Otherwise choose **CUDA 3090** if it meets the same bar. In that case the CUDA route also needs `nvidia-container-toolkit` + CDI on the appliance.
  - That is **out of scope for this plan**. Create a follow-up task under the W6 epic: "respin: add nvidia-container-toolkit + CDI for decision engine".
  - Until it lands, T6 uses the manual `--device` + lib binds from Step 6 as `<PODMAN_GPU_ARGS>`.
- If neither variant meets the bar, **stop and ask the operator**. CPU (≈3 s for 10 questions) cannot meet the 700 ms rerank budget.

**Distribution:**
- If `<IMAGE_BYTES>` ≤ 2 GiB, take the **T5 OCI-tar preload branch**. `<DECISION_IMAGE>` = `sha256:<image id>`.
- Otherwise, push to a registry:
  ```bash
  podman tag localhost/laya-server:<tag> ghcr.io/yolanother/laya-server:<LAYA_SERVER_SHA>-<VARIANT>
  podman push --digestfile /tmp/laya.digest ghcr.io/yolanother/laya-server:<LAYA_SERVER_SHA>-<VARIANT>
  ```
  - `<DECISION_IMAGE>` = `ghcr.io/yolanother/laya-server@$(cat /tmp/laya.digest)`. Paste the literal value.
  - The package must be public (GitHub → Packages → laya-server → visibility), or the appliance pull fails without credentials.
  - Pushing needs `podman login ghcr.io` by the operator. If there are no credentials, ask with `orch tasks ask`.

**Frostburn:**
- `<MIN_FREE_BYTES>` = 2 × the measured peak (container RSS + GPU memory), rounded up to a GiB, with a floor of 4 GiB.
- If Frostburn's busiest-state MemAvailable is below `<MIN_FREE_BYTES>`, Frostburn still enables DECISION: the guard simply refuses local fallback at those times. Record that expectation.

- [ ] **Step 9: Clean up and record**

```bash
drakemore ssh 'rm -f /var/tmp/laya-*.tar /var/tmp/laya-run.sh'
rm -f /tmp/laya-rocm.tar /tmp/laya-cuda.tar
orch tasks progress <W6-T0 id> "<table: variant | device | p50/p95 @1/5/10 | GPU mem | RSS | coexist http | image id | size>; decision: <VARIANT>, <branch>; values: DECISION_IMAGE=…, PODMAN_GPU_ARGS=…, DEVICE=…, GPU_POOL=…, MIN_FREE_BYTES=…; next: T1" --json
```

---

### Task 1: DECISION engine supervisor + config defaults + runtime path + registry entry

**Files:**
- Create: `api/decision.js`, `api/decision.test.js`, `api/decision-supervisor.js`, `api/decision-supervisor.test.js`
- Modify: `api/runtime-paths.js:17-44`, `api/runtime-paths.test.js` (both `deepEqual` objects), `api/engines.js:21` and `:284-342`, `api/engines.test.js` (append), `api/server.js` (imports near L57/L217, supervisor near L8198, stats L3896, shutdown L16868)

**Interfaces:**
- Consumes: the T0 values.
- Produces (later tasks rely on these exact names):
  - `api/decision.js`:
    - constants `DECISION_CONTAINER_NAME`, `LAYA_CONTAINER_PORT`, `LAYA_HOST_HEADER`, `LAYA_HOP_HEADER`, `SYSTEM_ONE_CAPABILITY`, `DECISION_DEFAULTS`
    - `resolveDecisionConfig(config, env) → {…DECISION_DEFAULTS, runnable:boolean, reason:string|null}`
    - `isPinnedImage(image) → boolean`
    - `podmanRunArgs(cfg, {cacheDir}) → string[]`
    - `isDecisionModel(model) → boolean`
    - `pickDecisionPatch(body) → object`
  - `api/decision-supervisor.js`: `createDecisionSupervisor({...}) → { ensureStarted():Promise<void>, touch():void, stop():Promise<void>, status():{running,healthy,startedAt,lastUsedAt,lastError} }`
  - `resolveRuntimePaths(...).decisionDir`
  - `ENGINE_TYPES.DECISION === 'decision'`
  - `buildLocalServerRegistry({…, decision})` adds an entry with `id:'decision'` only when `decision` is passed.
  - In `server.js`: `decisionSupervisor`, `decisionConfig()`.

- [ ] **Step 1: Write the failing config/argv tests**

`api/decision.test.js`:

```js
// Llama Manager — unit tests for api/decision.js (System 1 decision engine policy).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_DEFAULTS, DECISION_CONTAINER_NAME, resolveDecisionConfig, isPinnedImage,
  podmanRunArgs, isDecisionModel, pickDecisionPatch,
} from './decision.js';

const DIGEST = 'a'.repeat(64);
const PINNED = `ghcr.io/yolanother/laya-server@sha256:${DIGEST}`;

test('resolveDecisionConfig: ships disabled on port 5254 with the typed-decisions checkpoint', () => {
  const c = resolveDecisionConfig({}, {});
  assert.equal(c.enabled, false);
  assert.equal(c.port, 5254);
  assert.equal(c.checkpoint, 'typed-decisions');
  assert.equal(c.idleTimeoutSec, 600);
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'disabled in config');
  assert.ok(isPinnedImage(DECISION_DEFAULTS.image), 'default image must be digest-pinned (T0 fills it)');
});

test('resolveDecisionConfig: config block is honoured and env overrides enabled/port', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, port: 6000 } }, { DECISION_PORT: '6100' });
  assert.equal(c.enabled, true);
  assert.equal(c.port, 6100);
  assert.equal(c.runnable, true);
  assert.equal(c.reason, null);
  assert.equal(resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, { DECISION_ENABLED: 'false' }).enabled, false);
});

test('resolveDecisionConfig: refuses an image that is not pinned by digest', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: 'ghcr.io/x/laya-server:latest' } }, {});
  assert.equal(c.runnable, false);
  assert.equal(c.reason, 'image is not pinned by digest');
});

test('resolveDecisionConfig: refuses an unknown checkpoint', () => {
  const c = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, checkpoint: 'huge' } }, {});
  assert.equal(c.runnable, false);
  assert.match(c.reason, /unknown checkpoint/);
});

test('isPinnedImage: accepts repo digests and full image ids only', () => {
  assert.equal(isPinnedImage(PINNED), true);
  assert.equal(isPinnedImage(`sha256:${DIGEST}`), true);
  assert.equal(isPinnedImage('laya-server:rocm'), false);
  assert.equal(isPinnedImage(`x@sha256:${DIGEST.slice(1)}`), false);
  assert.equal(isPinnedImage(undefined), false);
});

test('podmanRunArgs: loopback port map, keep-id cache mount, checkpoint env, gpu args, image last', () => {
  const cfg = resolveDecisionConfig({ decision: { enabled: true, image: PINNED, device: 'cuda:0',
    podmanArgs: ['--device', '/dev/kfd'] } }, {});
  const args = podmanRunArgs(cfg, { cacheDir: '/var/lib/llama-manager/decision' });
  assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--pull=missing', '--name', DECISION_CONTAINER_NAME]);
  assert.ok(args.includes('--userns=keep-id:uid=1000,gid=1000'));
  assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1:5254:8765');
  assert.equal(args[args.indexOf('-v') + 1], '/var/lib/llama-manager/decision:/data');
  assert.ok(args.includes('LAYA_SERVER_MODELS=typed-decisions'));
  assert.ok(args.includes('LAYA_SERVER_JEV_ALIAS=1'));
  assert.ok(args.includes('LAYA_SERVER_DEVICE=cuda:0'));
  assert.ok(args.includes('/dev/kfd'));
  assert.equal(args.at(-1), PINNED);
});

test('isDecisionModel: laya, laya-*, jev-* and omitted are accepted; chat models are not', () => {
  for (const m of [undefined, '', 'laya', 'laya-typed-decisions', 'jev-latest', 'jev-1.13.0']) assert.equal(isDecisionModel(m), true, String(m));
  for (const m of ['gpt-oss-120b', 'default-big', 'layabout', 'JEV-latest']) assert.equal(isDecisionModel(m), false, m);
});

test('pickDecisionPatch: keeps only decision config keys', () => {
  assert.deepEqual(pickDecisionPatch({ enabled: true, port: 5254, rm: '-rf', __proto__x: 1 }), { enabled: true, port: 5254 });
  assert.deepEqual(pickDecisionPatch(null), {});
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test api/decision.test.js`
Expected: FAIL with `Cannot find module '…/api/decision.js'`.

- [ ] **Step 3: Implement `api/decision.js`**

Replace the three `DEFAULT_DECISION_*` literals with the T0 values.

```js
// Llama Manager — System 1 decision engine (Laya) policy helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free policy for the DECISION engine: one laya-server Podman
// container that answers Jev-compatible POST /v1/systemone requests with a
// ModernBERT decision model. Resolves the `config.decision` block (+ DECISION_*
// env overrides) into a config with a `runnable` verdict, refuses images not
// pinned by digest, builds the `podman run` argv (loopback port map, keep-id
// weights cache mount, checkpoint/device env, GPU passthrough flags), decides
// which request model names the proxy accepts, whitelists config patches, plans
// the `laya` alias route (configured peers → local → none) and appends the
// `system_one` fleet capability. Kept out of server.js so it is unit-testable.

/** Name of the single supervised laya-server container. */
export const DECISION_CONTAINER_NAME = 'llama-manager-decision';
/** Port laya-server listens on inside its container (Dockerfile EXPOSE). */
export const LAYA_CONTAINER_PORT = 8765;
/** Response header naming the node whose engine answered. */
export const LAYA_HOST_HEADER = 'x-laya-host';
/** Request header set when a peer forwards a request; the receiver serves locally only. */
export const LAYA_HOP_HEADER = 'x-laya-hop';
/** Fleet capability token appended to the advertised engines list. */
export const SYSTEM_ONE_CAPABILITY = 'system_one';
/** Checkpoints laya-server can load (LAYA_SERVER_MODELS values). */
export const LAYA_CHECKPOINTS = ['english', 'multilingual', 'typed-decisions'];

// SPIKE (T0): digest-pinned image, GPU passthrough flags and device for the winning variant.
const DEFAULT_DECISION_IMAGE = '<DECISION_IMAGE>';
const DEFAULT_DECISION_PODMAN_ARGS = [/* <PODMAN_GPU_ARGS>, e.g. '--device', '/dev/kfd', ... */];
const DEFAULT_DECISION_DEVICE = '<DEVICE>';

/** Defaults for `config.decision`; every key here is also a settable config key. */
export const DECISION_DEFAULTS = Object.freeze({
  enabled: false,
  image: DEFAULT_DECISION_IMAGE,
  checkpoint: 'typed-decisions',
  gpu: '',
  device: DEFAULT_DECISION_DEVICE,
  podmanArgs: DEFAULT_DECISION_PODMAN_ARGS,
  port: 5254,
  idleTimeoutSec: 600,
  startTimeoutSec: 900,
  minFreeMemBytes: 4 * 1024 ** 3, // SPIKE (T0): <MIN_FREE_BYTES>
  peers: [],
  peerHealthTtlMs: 10_000,
  forwardTimeoutMs: 15_000,
});

/**
 * True when an image reference cannot drift: a repo digest (`…@sha256:<64 hex>`)
 * or a full local image id (`sha256:<64 hex>`).
 * @param {string|undefined} image
 * @returns {boolean}
 */
export function isPinnedImage(image) {
  return /(^|@)sha256:[0-9a-f]{64}$/.test(String(image || ''));
}

/**
 * Resolve the decision engine config from config.json + environment.
 * DECISION_ENABLED ('true'/'false') and DECISION_PORT override the block.
 * @param {object} config Parsed config.json.
 * @param {object} env Environment (e.g. process.env).
 * @returns {object} DECISION_DEFAULTS shape plus `runnable` (safe to start) and
 *   `reason` (why not, or null).
 */
export function resolveDecisionConfig(config = {}, env = {}) {
  const d = { ...DECISION_DEFAULTS, ...(config.decision || {}) };
  if (env.DECISION_ENABLED !== undefined) d.enabled = env.DECISION_ENABLED === 'true';
  if (env.DECISION_PORT) d.port = Number(env.DECISION_PORT);
  d.enabled = Boolean(d.enabled);
  d.port = Number(d.port);
  const reason = !d.enabled ? 'disabled in config'
    : !isPinnedImage(d.image) ? 'image is not pinned by digest'
    : !LAYA_CHECKPOINTS.includes(d.checkpoint) ? `unknown checkpoint ${d.checkpoint}`
    : null;
  return { ...d, runnable: reason === null, reason };
}

/**
 * Build the `podman run` argv (without the `podman` binary) for the container.
 * The API binds to loopback only; peers reach it through llama-manager's proxy.
 * `keep-id` maps the service user onto the image's uid 1000 so the weights cache
 * mount is writable under rootless Podman.
 * @param {object} cfg Result of resolveDecisionConfig.
 * @param {{cacheDir:string}} paths Host weights cache directory.
 * @returns {string[]}
 */
export function podmanRunArgs(cfg, { cacheDir }) {
  return [
    'run', '--rm', '--pull=missing', '--name', DECISION_CONTAINER_NAME,
    '--userns=keep-id:uid=1000,gid=1000',
    '-p', `127.0.0.1:${cfg.port}:${LAYA_CONTAINER_PORT}`,
    '-v', `${cacheDir}:/data`,
    '-e', `LAYA_SERVER_MODELS=${cfg.checkpoint}`,
    '-e', 'LAYA_SERVER_JEV_ALIAS=1',
    ...(cfg.device ? ['-e', `LAYA_SERVER_DEVICE=${cfg.device}`] : []),
    ...(Array.isArray(cfg.podmanArgs) ? cfg.podmanArgs : []),
    cfg.image,
  ];
}

/**
 * Whether a request's `model` belongs to the decision engine. An omitted model
 * is accepted (laya-server routes it itself).
 * @param {string|undefined} model
 * @returns {boolean}
 */
export function isDecisionModel(model) {
  if (model === undefined || model === null || model === '') return true;
  return model === 'laya' || /^laya-/.test(model) || /^jev-/.test(model);
}

/**
 * Keep only known `config.decision` keys from an API body.
 * @param {object|null} body
 * @returns {object}
 */
export function pickDecisionPatch(body) {
  return Object.fromEntries(Object.entries(body || {}).filter(([k]) => Object.hasOwn(DECISION_DEFAULTS, k)));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test api/decision.test.js`
Expected: PASS (8 tests). If the default-image assertion fails, the T0 value was not pasted in; paste it.

- [ ] **Step 5: Write the failing supervisor tests**

`api/decision-supervisor.test.js`:

```js
// Llama Manager — unit tests for api/decision-supervisor.js (laya-server lazy supervisor).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDecisionSupervisor } from './decision-supervisor.js';
import { resolveDecisionConfig, DECISION_CONTAINER_NAME } from './decision.js';

const PINNED = `sha256:${'b'.repeat(64)}`;

/** Fake child process with the exit/kill/stdio surface the supervisor uses. */
function fakeProc() {
  const p = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; return true; };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

/** Build a supervisor with recording fakes and a manual clock. */
function makeSup({ enabled = true, healthyAfter = 0, config, sleep } = {}) {
  const calls = { spawn: [], podman: [], timers: [], dirs: [] };
  const clock = { t: 0 };
  let probes = 0;
  const procs = [];
  const cfg = config || { decision: { enabled, image: PINNED, idleTimeoutSec: 60, startTimeoutSec: 5 } };
  const sup = createDecisionSupervisor({
    spawn: (cmd, args) => { const p = fakeProc(); calls.spawn.push({ cmd, args }); procs.push(p); return p; },
    runPodman: async (args) => { calls.podman.push(args); },
    fetchFn: async () => ({ ok: probes++ >= healthyAfter }),
    getConfig: () => resolveDecisionConfig(cfg, {}),
    cacheDir: '/cache/decision',
    ensureDir: (d) => calls.dirs.push(d),
    now: () => clock.t,
    sleep: sleep || (async (ms) => { clock.t += ms; }),
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, cleared: false }; calls.timers.push(h); return h; },
    clearTimeoutFn: (h) => { if (h) h.cleared = true; },
  });
  return { sup, calls, procs, clock };
}

test('ensureStarted: creates the cache dir, clears a stale container, spawns podman run, waits for /healthz', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 2 });
  await sup.ensureStarted();
  assert.deepEqual(calls.dirs, ['/cache/decision']);
  assert.deepEqual(calls.podman[0], ['rm', '-f', DECISION_CONTAINER_NAME]);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].cmd, 'podman');
  assert.equal(calls.spawn[0].args[0], 'run');
  assert.equal(calls.spawn[0].args.at(-1), PINNED);
  assert.deepEqual({ running: sup.status().running, healthy: sup.status().healthy }, { running: true, healthy: true });
});

test('ensureStarted: a running healthy engine is reused, and concurrent callers share one spawn', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 1 });
  await Promise.all([sup.ensureStarted(), sup.ensureStarted(), sup.ensureStarted()]);
  await sup.ensureStarted();
  assert.equal(calls.spawn.length, 1);
});

test('ensureStarted: refuses when not runnable and never spawns', async () => {
  const { sup, calls } = makeSup({ enabled: false });
  await assert.rejects(sup.ensureStarted(), /not runnable: disabled in config/);
  assert.equal(calls.spawn.length, 0);
});

test('ensureStarted: container exit during start rejects with the exit code', async () => {
  // sleep yields a macrotask without advancing the clock, so only the exit can end the wait
  const { sup, procs } = makeSup({ healthyAfter: 1000, sleep: () => new Promise((r) => setImmediate(r)) });
  const pending = sup.ensureStarted();
  await new Promise((r) => setImmediate(r));
  procs[0].emit('exit', 125);
  await assert.rejects(pending, /exited with code 125/);
  assert.equal(sup.status().running, false);
});

test('ensureStarted: start timeout stops the container and rejects', async () => {
  const { sup, calls } = makeSup({ healthyAfter: 1000 });
  await assert.rejects(sup.ensureStarted(), /not healthy after 5s/);
  assert.deepEqual(calls.podman.at(-1), ['stop', '-t', '10', DECISION_CONTAINER_NAME]);
  assert.equal(sup.status().running, false);
});

test('idle timeout: each touch re-arms the timer; firing it stops the container', async () => {
  const { sup, calls } = makeSup();
  await sup.ensureStarted();
  sup.touch();
  const live = calls.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 60_000);
  await live[0].fn();
  assert.deepEqual(calls.podman.at(-1), ['stop', '-t', '10', DECISION_CONTAINER_NAME]);
  assert.equal(sup.status().running, false);
  assert.ok(sup.status().lastUsedAt !== null);
});

test('stop on a never-started supervisor is a no-op', async () => {
  const { sup, calls } = makeSup();
  await sup.stop();
  assert.equal(calls.podman.length, 0);
});
```

- [ ] **Step 6: Run the supervisor tests and confirm they fail**

Run: `node --test api/decision-supervisor.test.js`
Expected: FAIL with `Cannot find module '…/api/decision-supervisor.js'`.

- [ ] **Step 7: Implement `api/decision-supervisor.js`**

```js
// Llama Manager — System 1 decision engine (laya-server) supervisor.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Dependency-injected, lazily started supervisor for the single laya-server
// Podman container behind the DECISION engine. ensureStarted() creates the
// weights cache dir, removes a stale container left by a crash, spawns
// `podman run` in the foreground (the child's lifetime is the container's), and
// polls GET /healthz until the weights are loaded or startTimeoutSec expires.
// Concurrent callers share one start. touch() records use and re-arms an idle
// timer; when it fires the container is stopped, and the next request starts it
// again. No auto-restart: an exit simply marks the engine down. All I/O (spawn,
// podman one-shots, fetch, clock, timers, mkdir) is injected for tests.

import { mkdirSync } from 'fs';
import { DECISION_CONTAINER_NAME, podmanRunArgs } from './decision.js';

/**
 * Create the decision engine supervisor.
 * @param {object} deps
 * @param {Function} deps.spawn child_process.spawn-compatible.
 * @param {(args:string[]) => Promise<void>} deps.runPodman Run a one-shot podman command.
 * @param {Function} [deps.fetchFn] fetch-compatible, used for /healthz.
 * @param {() => object} deps.getConfig Returns resolveDecisionConfig(...).
 * @param {string} deps.cacheDir Host weights cache dir mounted at /data.
 * @param {(dir:string) => void} [deps.ensureDir]
 * @param {() => number} [deps.now]
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {Function} [deps.setTimeoutFn]
 * @param {Function} [deps.clearTimeoutFn]
 * @param {(msg:string) => void} [deps.log]
 * @returns {{ensureStarted:() => Promise<void>, touch:() => void, stop:() => Promise<void>,
 *   status:() => {running:boolean, healthy:boolean, startedAt:number|null, lastUsedAt:number|null, lastError:string|null}}}
 */
export function createDecisionSupervisor({
  spawn,
  runPodman,
  fetchFn = fetch,
  getConfig,
  cacheDir,
  ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
}) {
  let proc = null;
  let healthy = false;
  let starting = null;
  let idleTimer = null;
  let startedAt = null;
  let lastUsedAt = null;
  let lastError = null;

  /** One /healthz probe; any failure reads as not ready. */
  async function probe(port) {
    try {
      const r = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Spawn the container and wait for health; rejects on exit or timeout. */
  async function start(cfg) {
    ensureDir(cacheDir);
    await runPodman(['rm', '-f', DECISION_CONTAINER_NAME]).catch(() => {});
    const p = spawn('podman', podmanRunArgs(cfg, { cacheDir }), { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    healthy = false;
    startedAt = now();
    lastError = null;
    p.stdout?.on('data', (d) => log(String(d)));
    p.stderr?.on('data', (d) => log(String(d)));
    p.on('exit', (code) => {
      if (proc !== p) return; // stopped or superseded
      proc = null;
      healthy = false;
      lastError = `laya-server exited with code ${code}`;
      log(lastError);
    });
    const deadline = now() + cfg.startTimeoutSec * 1000;
    while (now() < deadline) {
      if (proc !== p) throw new Error(lastError || 'laya-server stopped during start');
      if (await probe(cfg.port)) { healthy = true; return; }
      await sleep(1000);
    }
    await stop();
    lastError = `laya-server not healthy after ${cfg.startTimeoutSec}s`;
    throw new Error(lastError);
  }

  /** Start if needed (shared across concurrent callers), then mark use. */
  async function ensureStarted() {
    const cfg = getConfig();
    if (!cfg.runnable) throw new Error(`decision engine not runnable: ${cfg.reason}`);
    if (!(proc && healthy)) {
      if (!starting) starting = start(cfg).finally(() => { starting = null; });
      await starting;
    }
    touch();
  }

  /** Record use and re-arm the idle stop. */
  function touch() {
    lastUsedAt = now();
    if (idleTimer) clearTimeoutFn(idleTimer);
    idleTimer = setTimeoutFn(() => stop().catch(() => {}), getConfig().idleTimeoutSec * 1000);
    idleTimer?.unref?.();
  }

  /** Stop the container (no restart). Safe when nothing is running. */
  async function stop() {
    if (idleTimer) { clearTimeoutFn(idleTimer); idleTimer = null; }
    const p = proc;
    proc = null;
    healthy = false;
    if (!p) return;
    await runPodman(['stop', '-t', '10', DECISION_CONTAINER_NAME]).catch(() => {});
    if (!p.killed) p.kill('SIGTERM');
  }

  /** Snapshot for /api/decision/status and the server registry. */
  function status() {
    return { running: !!proc, healthy, startedAt, lastUsedAt, lastError };
  }

  return { ensureStarted, touch, stop, status };
}
```

- [ ] **Step 8: Run the supervisor tests and confirm they pass**

Run: `node --test api/decision-supervisor.test.js`
Expected: PASS (7 tests).

- [ ] **Step 9: Write the failing runtime-path and registry tests**

In `api/runtime-paths.test.js`, add `decisionDir` to both expected objects:
- packaged block: `decisionDir: '/var/lib/llama-manager/decision',`
- source block: `decisionDir: '/home/alice/src/llama-manager/data/decision',`

Also append this test:

```js
test('DECISION_CACHE_DIR overrides the decision weights cache', () => {
  const paths = resolveRuntimePaths({ DECISION_CACHE_DIR: '/fast/decision' }, { projectRoot: '/p', home: '/h' });
  assert.equal(paths.decisionDir, '/fast/decision');
});
```

Append to `api/engines.test.js`:

```js
test('buildLocalServerRegistry: decision entry only when passed, same uniform shape', () => {
  const base = {
    llama: { running: true, healthy: true, port: 5251, models: [] },
    embed: { running: false, healthy: false, port: 5252, models: [] },
    ds4: { ds4Config: resolveDs4Config({}, {}), running: false, freeMemBytes: 10 * 1024 ** 3 },
  };
  assert.equal(buildLocalServerRegistry(base).some((s) => s.id === 'decision'), false);

  const idle = buildLocalServerRegistry({ ...base, decision: { running: false, runnable: true, reason: null, port: 5254, models: ['typed-decisions'] } })
    .find((s) => s.id === 'decision');
  assert.equal(idle.type, ENGINE_TYPES.DECISION);
  assert.equal(idle.state, 'idle');
  assert.deepEqual(Object.keys(idle).sort(), Object.keys(buildLocalServerRegistry(base)[0]).sort());

  const off = buildLocalServerRegistry({ ...base, decision: { running: false, runnable: false, reason: 'disabled in config', port: 5254 } })
    .find((s) => s.id === 'decision');
  assert.equal(off.state, 'down');
  assert.deepEqual(off.enable, { eligible: false, reason: 'disabled in config' });

  const up = buildLocalServerRegistry({ ...base, decision: { running: true, healthy: true, runnable: true, port: 5254 } })
    .find((s) => s.id === 'decision');
  assert.equal(up.state, 'running');
});
```

Run: `node --test api/runtime-paths.test.js api/engines.test.js`
Expected: FAIL. The deepEqual shows the missing `decisionDir`, and the registry test fails on `ENGINE_TYPES.DECISION` being undefined.

- [ ] **Step 10: Implement the path and registry changes**

`api/runtime-paths.js`:
- Add `decisionDir:string` to the `@returns` JSDoc type.
- Add this after `slotCacheDir`:

```js
    // Laya decision engine weights (HF cache mounted at the container's /data).
    decisionDir: env.DECISION_CACHE_DIR || join(dataDir, 'decision'),
```

`api/engines.js`:
- L21: change to `export const ENGINE_TYPES = { LLAMA: 'llama', DS4: 'ds4', DECISION: 'decision' };`
- Update the header purpose sentence to mention "the laya decision sidecar's registry entry".
- In `buildLocalServerRegistry`:
  - change the signature to `({ llama = {}, embed = {}, ds4 = {}, decision = null } = {})`
  - add `@param` text: "`decision` (optional): `{running, healthy, runnable, reason, port, models}` from the decision supervisor; omitted ⇒ no entry"
  - replace the final `return` with:

```js
  const entries = [llamaEntry, embedEntry, ds4Entry];
  if (decision) {
    const decisionEntry = entry('decision', ENGINE_TYPES.DECISION, 'Decision (Laya)', 'decision',
      { ...decision, idleReady: !!decision.runnable },
      { router: false, slots: false, vision: false, speculative: false });
    if (!decision.runnable) decisionEntry.enable = { eligible: false, reason: decision.reason };
    entries.push(decisionEntry);
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
```

Run: `node --test api/runtime-paths.test.js api/engines.test.js api/decision.test.js api/decision-supervisor.test.js`
Expected: PASS.

- [ ] **Step 11: Wire the supervisor into `api/server.js`**

1. Imports. Add these near L57, next to the embeddings import:

```js
import { resolveDecisionConfig } from './decision.js';
import { createDecisionSupervisor } from './decision-supervisor.js';
```

2. After the embed supervisor block (immediately after `getEmbedHealth`, ~L8273), add:

```js
// ── System 1 decision engine (laya-server container) ─────────────────────
/** Current decision engine config (config.json `decision` + DECISION_* env). */
function decisionConfig() {
  return resolveDecisionConfig(config, process.env);
}

/** Run a one-shot podman command (rm/stop); rejects on non-zero exit. */
function runPodman(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('podman', args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`podman ${args[0]} exited ${code}`))));
  });
}

const decisionSupervisor = createDecisionSupervisor({
  spawn,
  runPodman,
  getConfig: decisionConfig,
  cacheDir: RUNTIME_PATHS.decisionDir,
  log: (msg) => addLog('decision', msg),
});
```

3. In `getSystemStats()`, pass the decision entry into `buildLocalServerRegistry({ … })`. Add this key after `ds4: {…}`:

```js
    decision: (() => {
      const dc = decisionConfig();
      return { ...decisionSupervisor.status(), runnable: dc.runnable, reason: dc.reason, port: dc.port, models: [`laya-${dc.checkpoint}`] };
    })(),
```

4. In `shutdownWithTimeout` (~L16868), add `decisionSupervisor.stop(),` to the `Promise.allSettled([...])` list, after `stopEmbedServer(),`.

5. Check: `node --check api/server.js` exits 0.

- [ ] **Step 12: Full gate, then commit**

Run: `node --test api/*.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 2` (the known `dev-config.test.js` pair). Any other failure is yours.

```bash
git add api/decision.js api/decision.test.js api/decision-supervisor.js api/decision-supervisor.test.js api/runtime-paths.js api/runtime-paths.test.js api/engines.js api/engines.test.js api/server.js
git commit -F LastChange.md   # "feat(decision): DECISION engine supervisor for a digest-pinned laya-server container"
```

---

### Task 2: `/v1/systemone` proxy, status/start/stop/config routes, `x-laya-host`

**Files:**
- Create: `api/decision-router.js`, `api/decision-router.test.js`
- Modify: `api/server.js` (mount before the SPA catch-all `app.get('*'` at ~L16017)

**Interfaces:**
- Consumes (T1): `resolveDecisionConfig`, `isDecisionModel`, `pickDecisionPatch`, `LAYA_HOST_HEADER`, and the supervisor `{ensureStarted, touch, stop, status}`.
- Produces: `createDecisionRouter({ expressImpl, fetchImpl, supervisor, getConfig, updateConfig, nodeName, memAvailableBytes, isLoopback, now })`, an Express Router.
  - `POST /v1/systemone` and `POST /api/v1/systemone`: forward to local :port. The local-only planner is replaced in T3.
  - `GET /api/decision/status` → `{node, enabled, runnable, reason, available, image, checkpoint, gpu, port, idleTimeoutSec, running, healthy, startedAt, lastUsedAt, lastError, peers:[]}`
  - `POST /api/decision/start` and `POST /api/decision/stop` (open, like `/api/server/start`)
  - `POST /api/decision/config` (loopback only). It persists whitelisted keys and returns `{ok, decision}`.

- [ ] **Step 1: Write the failing route tests**

`api/decision-router.test.js`:

```js
// Llama Manager — route tests for api/decision-router.js (System 1 proxy + decision status).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionRouter } from './decision-router.js';
import { resolveDecisionConfig } from './decision.js';

const PINNED = `sha256:${'c'.repeat(64)}`;

/** Fake Express surface: records routes; no body parsing (app.use(express.json()) runs upstream). */
function harness(overrides = {}) {
  const routes = new Map();
  const router = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  const state = {
    decision: { enabled: true, image: PINNED, port: 5254 },
    running: false,
    starts: 0,
    touches: 0,
    stops: 0,
    fetches: [],
    availableBytes: 64 * 1024 ** 3,
    ...overrides.state,
  };
  const supervisor = {
    ensureStarted: async () => { state.starts++; state.running = true; },
    touch: () => { state.touches++; },
    stop: async () => { state.stops++; state.running = false; },
    status: () => ({ running: state.running, healthy: state.running, startedAt: null, lastUsedAt: null, lastError: null }),
  };
  const fetchImpl = overrides.fetchImpl || (async (url, init) => {
    state.fetches.push({ url, init });
    return new Response(JSON.stringify({ model: 'laya-typed-decisions', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 0 } }), { status: 200 });
  });
  createDecisionRouter({
    expressImpl: { Router: () => router },
    fetchImpl,
    supervisor,
    getConfig: () => resolveDecisionConfig({ decision: state.decision }, {}),
    updateConfig: (patch) => { state.decision = { ...state.decision, ...patch }; },
    nodeName: () => 'frostburn',
    memAvailableBytes: () => state.availableBytes,
    isLoopback: (req) => req.socket?.remoteAddress === '127.0.0.1',
    fleetPeers: overrides.fleetPeers,
  });
  return { routes, state };
}

/** Invoke a recorded handler with a fake req/res; resolves to the res. */
async function invoke(routes, key, { body, headers = {}, remote = '127.0.0.1' } = {}) {
  const res = {
    statusCode: 200, headers: {},
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
  };
  await routes.get(key)({ body, headers, socket: { remoteAddress: remote } }, res);
  return res;
}

const Q = { questions: { q: { type: 'noul', instructions: 'invoice?' } }, state: 'INV-1' };

test('systemone: registered on /v1 and /api/v1', () => {
  const { routes } = harness();
  assert.ok(routes.has('POST /v1/systemone'));
  assert.ok(routes.has('POST /api/v1/systemone'));
});

test('systemone: rejects a non-decision model with 400 and still names the host', async () => {
  const { routes, state } = harness();
  const res = await invoke(routes, 'POST /v1/systemone', { body: { ...Q, model: 'gpt-oss-120b' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'unsupported_model');
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  assert.equal(state.starts, 0);
});

for (const model of [undefined, 'laya', 'laya-typed-decisions', 'jev-latest']) {
  test(`systemone: model ${model} lazily starts local, forwards, touches, sets x-laya-host`, async () => {
    const { routes, state } = harness();
    const res = await invoke(routes, 'POST /api/v1/systemone', { body: { ...Q, model } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.answers.q.noul, 0.9);
    assert.equal(res.headers['x-laya-host'], 'frostburn');
    assert.equal(state.starts, 1);
    assert.ok(state.touches >= 1);
    assert.equal(state.fetches[0].url, 'http://127.0.0.1:5254/v1/systemone');
    assert.deepEqual(JSON.parse(state.fetches[0].init.body), { ...Q, model });
  });
}

test('systemone: upstream 422 is passed through, not failed over', async () => {
  const { routes } = harness({ fetchImpl: async () => new Response(JSON.stringify({ detail: 'bad question' }), { status: 422 }) });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.detail, 'bad question');
});

test('systemone: disabled engine → 503 no_decision_host', async () => {
  const { routes, state } = harness({ state: { decision: { enabled: false, image: PINNED } } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'no_decision_host' });
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  assert.equal(state.starts, 0);
});

test('systemone: memory guard refuses a cold start below minFreeMemBytes', async () => {
  const { routes, state } = harness({ state: { availableBytes: 1024 } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  assert.equal(state.starts, 0);
});

test('systemone: memory guard keeps an already-running engine serving', async () => {
  const { routes } = harness({ state: { availableBytes: 1024, running: true } });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 200);
});

test('systemone: local 5xx or a thrown start → 503', async () => {
  const { routes } = harness({ fetchImpl: async () => new Response('{"detail":"oom"}', { status: 500 }) });
  assert.equal((await invoke(routes, 'POST /v1/systemone', { body: Q })).statusCode, 503);
});

test('status: reports config, supervisor state, availability and node', async () => {
  const { routes } = harness();
  const res = await invoke(routes, 'GET /api/decision/status');
  assert.equal(res.body.node, 'frostburn');
  assert.equal(res.body.available, true);
  assert.equal(res.body.port, 5254);
  assert.equal(res.body.running, false);
  assert.deepEqual(res.body.peers, []);
  assert.equal(res.headers['x-laya-host'], 'frostburn');
});

test('config: off-box callers get 403; loopback persists only known keys', async () => {
  const { routes, state } = harness();
  assert.equal((await invoke(routes, 'POST /api/decision/config', { body: { enabled: false }, remote: '192.168.1.5' })).statusCode, 403);
  const res = await invoke(routes, 'POST /api/decision/config', { body: { enabled: false, gpu: 'rocm-igpu', evil: 1 } });
  assert.equal(res.body.ok, true);
  assert.equal(state.decision.enabled, false);
  assert.equal(state.decision.gpu, 'rocm-igpu');
  assert.equal('evil' in state.decision, false);
});

test('start/stop: drive the supervisor', async () => {
  const { routes, state } = harness();
  assert.equal((await invoke(routes, 'POST /api/decision/start')).body.running, true);
  assert.equal((await invoke(routes, 'POST /api/decision/stop')).body.running, false);
  assert.equal(state.stops, 1);
});

test('start: not runnable → 409 with the reason', async () => {
  const { routes } = harness({ state: { decision: { enabled: false, image: PINNED } } });
  const res = await invoke(routes, 'POST /api/decision/start');
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /disabled in config/);
});
```

For the last test, the fake `ensureStarted` must honour `runnable`. Replace it in `harness` with:

```js
    ensureStarted: async () => {
      const c = resolveDecisionConfig({ decision: state.decision }, {});
      if (!c.runnable) throw new Error(`decision engine not runnable: ${c.reason}`);
      state.starts++; state.running = true;
    },
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test api/decision-router.test.js`
Expected: FAIL with `Cannot find module '…/api/decision-router.js'`.

- [ ] **Step 3: Implement `api/decision-router.js`**

```js
// Llama Manager — System 1 decision engine HTTP routes.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Express router for the DECISION engine. POST /v1/systemone and
// /api/v1/systemone accept Jev-wire bodies whose model is laya, laya-*, jev-*
// or omitted, walk an ordered target list (configured peers, then the local
// laya-server container when the memory guard allows a cold start), and return
// the first non-5xx answer verbatim with an `x-laya-host` header naming the node
// that served it; when nothing can serve, 503 {error:"no_decision_host"}. Also
// serves GET /api/decision/status (config, supervisor state, peer health),
// POST /api/decision/start|stop for the dashboard card, and a loopback-only
// POST /api/decision/config that persists whitelisted `decision` keys (used by
// scripts/decision-enable.sh). All collaborators are injected for route tests.

import express from 'express';
import { LAYA_HOST_HEADER, isDecisionModel, pickDecisionPatch } from './decision.js';

/** Read an upstream body as JSON, wrapping non-JSON text. */
async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'invalid_upstream_body', detail: text.slice(0, 500) };
  }
}

/**
 * Create the decision engine router.
 * @param {object} deps
 * @param {object} [deps.expressImpl] express (tests pass a fake with Router()).
 * @param {Function} [deps.fetchImpl] fetch-compatible.
 * @param {{ensureStarted:Function, touch:Function, stop:Function, status:Function}} deps.supervisor
 * @param {() => object} deps.getConfig Returns resolveDecisionConfig(...).
 * @param {(patch:object) => void} deps.updateConfig Merge + persist config.decision.
 * @param {() => string} deps.nodeName This node's name (x-laya-host).
 * @param {() => number} deps.memAvailableBytes Current MemAvailable in bytes.
 * @param {(req:object) => boolean} deps.isLoopback Loopback-caller check.
 * @param {() => number} [deps.now]
 * @returns {object} Express router.
 */
export function createDecisionRouter({
  expressImpl = express,
  fetchImpl = globalThis.fetch,
  supervisor,
  getConfig,
  updateConfig,
  nodeName,
  memAvailableBytes,
  isLoopback,
  now = () => Date.now(),
}) {
  const router = expressImpl.Router();
  /** url → {available, checkedAt}; filled by T3's peer health checks. */
  const peerHealth = new Map();

  /** Ordered targets for one request. T2: local only; T3 prepends configured peers. */
  async function planTargets(req, cfg) {
    const local = supervisor.status();
    return cfg.runnable && (local.running || memAvailableBytes() >= cfg.minFreeMemBytes) ? [{ kind: 'local' }] : [];
  }

  /** Forward to the local container, starting it lazily. */
  async function callLocal(body, cfg) {
    await supervisor.ensureStarted();
    try {
      const r = await fetchImpl(`http://127.0.0.1:${cfg.port}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.forwardTimeoutMs),
      });
      return { status: r.status, body: await readBody(r), host: nodeName() };
    } finally {
      supervisor.touch();
    }
  }

  /** Call one target. T3 adds the peer branch. */
  const callTarget = (target, body, cfg) => callLocal(body, cfg);
  /** Record a failed target. T3 marks peers down in peerHealth. */
  function markDown() {}

  /** POST /v1/systemone handler. */
  async function handleSystemOne(req, res) {
    const cfg = getConfig();
    res.set(LAYA_HOST_HEADER, nodeName());
    const model = req.body?.model;
    if (!isDecisionModel(model)) return res.status(400).json({ error: 'unsupported_model', model });
    for (const target of await planTargets(req, cfg)) {
      try {
        const r = await callTarget(target, req.body, cfg);
        if (r.status >= 500) { markDown(target); continue; }
        res.set(LAYA_HOST_HEADER, r.host);
        return res.status(r.status).json(r.body);
      } catch {
        markDown(target);
      }
    }
    return res.status(503).json({ error: 'no_decision_host' });
  }

  router.post('/v1/systemone', handleSystemOne);
  router.post('/api/v1/systemone', handleSystemOne);

  router.get('/api/decision/status', (req, res) => {
    const cfg = getConfig();
    res.set(LAYA_HOST_HEADER, nodeName());
    res.json({
      node: nodeName(),
      enabled: cfg.enabled,
      runnable: cfg.runnable,
      reason: cfg.reason,
      available: cfg.runnable,
      image: cfg.image,
      checkpoint: cfg.checkpoint,
      gpu: cfg.gpu,
      port: cfg.port,
      idleTimeoutSec: cfg.idleTimeoutSec,
      ...supervisor.status(),
      peers: [...peerHealth].map(([url, h]) => ({ url, ...h })),
    });
  });

  router.post('/api/decision/start', async (req, res) => {
    try {
      await supervisor.ensureStarted();
      res.json({ ok: true, ...supervisor.status() });
    } catch (err) {
      res.status(409).json({ error: err.message, ...supervisor.status() });
    }
  });

  router.post('/api/decision/stop', async (req, res) => {
    await supervisor.stop();
    res.json({ ok: true, ...supervisor.status() });
  });

  router.post('/api/decision/config', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: 'decision config may only be changed from this machine', code: 'NOT_LOOPBACK' });
    updateConfig(pickDecisionPatch(req.body));
    return res.json({ ok: true, decision: getConfig() });
  });

  return router;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test api/decision-router.test.js`
Expected: PASS (15 tests; `fleetPeers` is ignored until T3).

- [ ] **Step 5: Mount in `api/server.js`**

1. Import near the other decision imports: `import { createDecisionRouter } from './decision-router.js';`
2. Immediately after `const decisionSupervisor = …` (T1 step 11), add:

```js
app.use(createDecisionRouter({
  supervisor: decisionSupervisor,
  getConfig: decisionConfig,
  updateConfig: (patch) => {
    config.decision = { ...(config.decision || {}), ...patch };
    saveConfig(config);
    if (patch.enabled === false) decisionSupervisor.stop().catch(() => {});
  },
  nodeName: () => describeNodeIdentity().name,
  memAvailableBytes,
  isLoopback: isLoopbackRequest,
}));
```

This call must appear **before** `app.get('*'` (~L16017). `app.use(express.json(...))` is at L290, so bodies are parsed. `isLoopbackRequest` is a hoisted function declaration (L5465), so the forward reference is fine.

3. Run `node --check api/server.js`.

- [ ] **Step 6: Local route smoke without a container (source mode)**

Run: `node --test api/*.test.js 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 2`.

Leave the dev server untouched (T6 deploys). Commit:

```bash
git add api/decision-router.js api/decision-router.test.js api/server.js
git commit -F LastChange.md   # "feat(decision): proxy /v1/systemone to the laya engine with x-laya-host and status routes"
```

---

### Task 3: Frostburn `laya` alias routing (configured peer → local → 503)

**Files:**
- Modify: `api/decision.js` (append), `api/decision.test.js` (append), `api/decision-router.js` (`planTargets`, `callTarget`, `markDown`, signature), `api/decision-router.test.js` (append), `api/server.js` (pass `fleetPeers`)

**Interfaces:**
- Consumes (T2): the router internals named above.
- Produces:
  - `resolvePeers(configured, fleet) → Array<{name,url}>`
  - `planDecisionRoute({peers, forwarded, peerAvailable, local}) → Array<{kind:'peer',name,url}|{kind:'local'}>`
  - `peerOffersDecision(peer) → boolean`
  - `createDecisionRouter({..., fleetPeers})`
- **Config:** `decision.peers` is the ordered preferred-peer list. Each entry is either:
  - `{ "name": "drakemore", "url": "http://192.168.1.79:3001" }`, a static URL, or
  - `{ "name": "drakemore" }`, resolved by name against fleet (mDNS) peers that advertise `system_one`.
- **Order:** only configured peers are tried before local. Unlisted fleet peers are never used automatically. That keeps drakemore, which has no peers configured, local-first, and prevents Frostburn↔drakemore ping-pong.
- **Loop guard:** a forwarded request carries `x-laya-hop: <sender>`, and the receiver plans local-only.
- **Peer health:** `GET <url>/api/decision/status` → `available === true`, cached `peerHealthTtlMs` (10 s) with a 1.5 s timeout. A failed forward marks the peer down for one TTL.

- [ ] **Step 1: Write the failing planner tests** (append to `api/decision.test.js`)

```js
import { resolvePeers, planDecisionRoute, peerOffersDecision } from './decision.js';

const LOCAL_OK = { runnable: true, running: false, availableBytes: 64 * 1024 ** 3, minFreeMemBytes: 4 * 1024 ** 3 };

test('resolvePeers: static urls kept in order, names resolved against the fleet, duplicates dropped', () => {
  const fleet = [{ name: 'drakemore', url: 'http://192.168.1.79:3001' }, { name: 'other', url: 'http://10.0.0.2:3001' }];
  assert.deepEqual(resolvePeers([{ name: 'drakemore' }, { name: 'static', url: 'http://h:1/' }, { name: 'ghost' }, { name: 'drakemore' }], fleet), [
    { name: 'drakemore', url: 'http://192.168.1.79:3001' },
    { name: 'static', url: 'http://h:1' },
  ]);
});

test('planDecisionRoute: healthy peer first, then local', () => {
  const peers = [{ name: 'drakemore', url: 'http://d:3001' }];
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => true, local: LOCAL_OK }),
    [{ kind: 'peer', name: 'drakemore', url: 'http://d:3001' }, { kind: 'local' }]);
});

test('planDecisionRoute: unhealthy peer skipped; low memory drops local; nothing → empty', () => {
  const peers = [{ name: 'drakemore', url: 'http://d:3001' }];
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: LOCAL_OK }), [{ kind: 'local' }]);
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: { ...LOCAL_OK, availableBytes: 1 } }), []);
  assert.deepEqual(planDecisionRoute({ peers, peerAvailable: () => false, local: { ...LOCAL_OK, availableBytes: 1, running: true } }), [{ kind: 'local' }]);
});

test('planDecisionRoute: a forwarded request never goes back out to peers', () => {
  const peers = [{ name: 'frostburn', url: 'http://f:5250' }];
  assert.deepEqual(planDecisionRoute({ peers, forwarded: true, peerAvailable: () => true, local: LOCAL_OK }), [{ kind: 'local' }]);
});

test('peerOffersDecision: reads the system_one token from the advertised engines TXT', () => {
  assert.equal(peerOffersDecision({ txt: { engines: 'llama,ds4,system_one' } }), true);
  assert.equal(peerOffersDecision({ txt: { engines: 'llama' } }), false);
  assert.equal(peerOffersDecision({}), false);
});
```

Run: `node --test api/decision.test.js`
Expected: FAIL (`resolvePeers` is not exported).

- [ ] **Step 2: Implement the planner** (append to `api/decision.js`)

```js
/**
 * Resolve the operator's ordered `decision.peers` into concrete {name,url}
 * targets. Entries with a url are used as-is (trailing slash trimmed); entries
 * with only a name are looked up among fleet peers advertising system_one.
 * Unknown names and duplicate urls are dropped.
 * @param {Array<{name?:string,url?:string}>} configured
 * @param {Array<{name:string,url:string}>} fleet
 * @returns {Array<{name:string,url:string}>}
 */
export function resolvePeers(configured = [], fleet = []) {
  const byName = new Map(fleet.map((p) => [p.name, p]));
  const seen = new Set();
  const out = [];
  for (const c of configured) {
    const p = c?.url ? { name: c.name || c.url, url: c.url.replace(/\/+$/, '') } : byName.get(c?.name);
    if (p && !seen.has(p.url)) { seen.add(p.url); out.push(p); }
  }
  return out;
}

/**
 * Plan the laya alias route for one request: available configured peers in
 * order (skipped when the request was already forwarded), then the local engine
 * when it is runnable and either already running or MemAvailable covers a cold
 * start. An empty plan means 503 no_decision_host.
 * @param {{peers?:Array<{name:string,url:string}>, forwarded?:boolean,
 *   peerAvailable?:(url:string)=>boolean,
 *   local:{runnable:boolean, running:boolean, availableBytes:number, minFreeMemBytes:number}}} input
 * @returns {Array<{kind:'peer',name:string,url:string}|{kind:'local'}>}
 */
export function planDecisionRoute({ peers = [], forwarded = false, peerAvailable = () => false, local }) {
  const targets = forwarded ? [] : peers.filter((p) => peerAvailable(p.url)).map((p) => ({ kind: 'peer', name: p.name, url: p.url }));
  if (local.runnable && (local.running || local.availableBytes >= local.minFreeMemBytes)) targets.push({ kind: 'local' });
  return targets;
}

/**
 * Whether a discovered fleet peer advertises the system_one capability.
 * @param {{txt?:{engines?:string}}} peer mdns-discovery peer record.
 * @returns {boolean}
 */
export function peerOffersDecision(peer) {
  return String(peer?.txt?.engines || '').split(',').includes(SYSTEM_ONE_CAPABILITY);
}
```

Run: `node --test api/decision.test.js`
Expected: PASS.

- [ ] **Step 3: Write the failing peer-routing route tests** (append to `api/decision-router.test.js`)

```js
/** fetch fake: peer status + peer/local systemone, recording calls. */
function peerFetch({ peerAvailable = true, peerStatus = 200, peerHost = 'drakemore' } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'http://d:3001/api/decision/status') return new Response(JSON.stringify({ available: peerAvailable }), { status: 200 });
    if (url === 'http://d:3001/api/v1/systemone') {
      return new Response(JSON.stringify({ model: 'laya-typed-decisions', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }),
        { status: peerStatus, headers: { 'x-laya-host': peerHost } });
    }
    if (url === 'http://127.0.0.1:5254/v1/systemone') return new Response(JSON.stringify({ model: 'local', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  return { fn, calls };
}

const WITH_PEER = { decision: { enabled: true, image: PINNED, port: 5254, peers: [{ name: 'drakemore', url: 'http://d:3001' }] } };

test('alias: healthy drakemore serves first; hop header sent; x-laya-host from the peer', async () => {
  const f = peerFetch();
  const { routes, state } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-laya-host'], 'drakemore');
  const fwd = f.calls.find((c) => c.url.endsWith('/api/v1/systemone'));
  assert.equal(fwd.init.headers['x-laya-hop'], 'frostburn');
  assert.equal(state.starts, 0, 'local engine not started when the peer serves');
});

test('alias: peer health is cached within peerHealthTtlMs', async () => {
  const f = peerFetch();
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  await invoke(routes, 'POST /v1/systemone', { body: Q });
  await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(f.calls.filter((c) => c.url.endsWith('/api/decision/status')).length, 1);
});

test('alias: peer unavailable → local serves with x-laya-host = this node', async () => {
  const f = peerFetch({ peerAvailable: false });
  const { routes, state } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.headers['x-laya-host'], 'frostburn');
  assert.equal(state.starts, 1);
});

test('alias: peer 503 → falls over to local and marks the peer down', async () => {
  const f = peerFetch({ peerStatus: 503 });
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.body.model, 'local');
  const status = await invoke(routes, 'GET /api/decision/status');
  assert.equal(status.body.peers[0].available, false);
});

test('alias: peer down and local memory too low → 503 no_decision_host', async () => {
  const f = peerFetch({ peerAvailable: false });
  const { routes } = harness({ state: { ...WITH_PEER, availableBytes: 1 }, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'no_decision_host' });
});

test('alias: a forwarded request (x-laya-hop) is served locally only', async () => {
  const f = peerFetch();
  const { routes } = harness({ state: WITH_PEER, fetchImpl: f.fn });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q, headers: { 'x-laya-hop': 'drakemore' } });
  assert.equal(res.body.model, 'local');
  assert.equal(f.calls.some((c) => c.url.startsWith('http://d:3001')), false);
});

test('alias: a name-only peer resolves through fleetPeers', async () => {
  const f = peerFetch();
  const { routes } = harness({
    state: { decision: { enabled: true, image: PINNED, port: 5254, peers: [{ name: 'drakemore' }] } },
    fetchImpl: f.fn,
    fleetPeers: () => [{ name: 'drakemore', url: 'http://d:3001' }],
  });
  const res = await invoke(routes, 'POST /v1/systemone', { body: Q });
  assert.equal(res.headers['x-laya-host'], 'drakemore');
});
```

Run: `node --test api/decision-router.test.js`
Expected: FAIL. The first alias test gets `x-laya-host` `frostburn`, because T2 plans local only.

- [ ] **Step 4: Implement peer routing in `api/decision-router.js`**

1. Imports: `import { LAYA_HOST_HEADER, LAYA_HOP_HEADER, isDecisionModel, pickDecisionPatch, resolvePeers, planDecisionRoute } from './decision.js';`
2. Signature: add `fleetPeers = () => [],` after `isLoopback,`. Add JSDoc: `@param {() => Array<{name:string,url:string}>} [deps.fleetPeers] Fleet peers advertising system_one.`
3. Replace the T2 `planTargets`, `callTarget` and `markDown` with:

```js
  /** Refresh one peer's cached availability when older than peerHealthTtlMs. */
  async function refreshPeer(url, cfg) {
    const h = peerHealth.get(url);
    if (h && now() - h.checkedAt < cfg.peerHealthTtlMs) return;
    let available = false;
    try {
      const r = await fetchImpl(`${url}/api/decision/status`, { signal: AbortSignal.timeout(1500) });
      available = r.ok && (await r.json()).available === true;
    } catch {
      // unreachable peer reads as unavailable
    }
    peerHealth.set(url, { available, checkedAt: now() });
  }

  /** Ordered targets: configured peers (unless forwarded) → local (memory guard) → none. */
  async function planTargets(req, cfg) {
    const forwarded = Boolean(req.headers?.[LAYA_HOP_HEADER]);
    const peers = forwarded ? [] : resolvePeers(cfg.peers, fleetPeers());
    await Promise.all(peers.map((p) => refreshPeer(p.url, cfg)));
    const local = supervisor.status();
    return planDecisionRoute({
      peers,
      forwarded,
      peerAvailable: (url) => peerHealth.get(url)?.available === true,
      local: { runnable: cfg.runnable, running: local.running, availableBytes: memAvailableBytes(), minFreeMemBytes: cfg.minFreeMemBytes },
    });
  }

  /** Forward to a peer llama-manager's proxy, marking the hop to prevent loops. */
  async function callPeer(target, body, cfg) {
    const r = await fetchImpl(`${target.url}/api/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LAYA_HOP_HEADER]: nodeName() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.forwardTimeoutMs),
    });
    return { status: r.status, body: await readBody(r), host: r.headers.get(LAYA_HOST_HEADER) || target.name };
  }

  /** Call one planned target. */
  const callTarget = (target, body, cfg) => (target.kind === 'peer' ? callPeer(target, body, cfg) : callLocal(body, cfg));

  /** A failed peer is unavailable until its cache entry ages out. */
  function markDown(target) {
    if (target.kind === 'peer') peerHealth.set(target.url, { available: false, checkedAt: now() });
  }
```

4. Update the file header's first sentence of routing behaviour if needed. It already says "configured peers, then the local…".

Run: `node --test api/decision-router.test.js api/decision.test.js`
Expected: PASS (all T2 tests still green).

- [ ] **Step 5: Pass fleet peers in `api/server.js`**

1. Add `peerOffersDecision` to the `./decision.js` import.
2. In the `createDecisionRouter({...})` call, add:

```js
  fleetPeers: () => lastKnownPeers
    .filter((peer) => peer.address && peerOffersDecision(peer))
    .map((peer) => ({ name: peer.txt?.name || peer.instance, url: `http://${peer.address}:${peer.port}` })),
```

`lastKnownPeers` is declared with `let` at ~L9925. It is read lazily inside the arrow, so the declaration order is safe, as long as the `app.use(createDecisionRouter(...))` line runs after L9925 is evaluated. If the mount sits above L9925, move the mount block to just after `refreshFleetView`'s declaration, and in any case before `app.get('*'`. Otherwise the TDZ throws `ReferenceError` on the first request, not at load.

3. Run `node --check api/server.js`, then `node --test api/*.test.js 2>&1 | grep -E '^# (pass|fail)'`. Expected: `# fail 2`.

- [ ] **Step 6: Commit**

```bash
git add api/decision.js api/decision.test.js api/decision-router.js api/decision-router.test.js api/server.js
git commit -F LastChange.md   # "feat(decision): laya alias routes configured peer → local → 503 with a hop guard"
```

---

### Task 4: Fleet `system_one` capability + dashboard card

**Files:**
- Modify: `api/decision.js` (append), `api/decision.test.js` (append), `api/server.js` (advertisement call ~L10098), `ui/src/pages/Dashboard.jsx:1182-1230`
- Create: `ui/src/pages/decision-card.js`, `ui/src/pages/decision-card.test.js`

**Interfaces:**
- Consumes (T1): `SYSTEM_ONE_CAPABILITY`, the `resolveDecisionConfig` result, and the registry entry `id:'decision'`.
- Produces:
  - `advertisedEngines(engines, cfg) → string[]`
  - `decisionCardAction(srv) → {label:'Start'|'Stop', path:'/decision/start'|'/decision/stop'} | null`

- [ ] **Step 1: Write the failing advertisement test** (append to `api/decision.test.js`)

```js
import { advertisedEngines } from './decision.js';

test('advertisedEngines: appends system_one only when the engine is runnable', () => {
  const on = resolveDecisionConfig({ decision: { enabled: true, image: PINNED } }, {});
  assert.deepEqual(advertisedEngines(['llama', 'ds4'], on), ['llama', 'ds4', 'system_one']);
  assert.deepEqual(advertisedEngines(['llama'], resolveDecisionConfig({}, {})), ['llama']);
  assert.deepEqual(advertisedEngines(['llama'], resolveDecisionConfig({ decision: { enabled: true, image: 'x:latest' } }, {})), ['llama']);
});
```

Run: `node --test api/decision.test.js`. Expected: FAIL (`advertisedEngines` is not exported).

- [ ] **Step 2: Implement it** (append to `api/decision.js`)

```js
/**
 * Engines to advertise over mDNS: the installed list plus `system_one` when the
 * decision engine is runnable here, so peers can find a Laya host by capability.
 * @param {string[]} engines installedEngines() result.
 * @param {object} cfg resolveDecisionConfig(...) result.
 * @returns {string[]}
 */
export function advertisedEngines(engines, cfg) {
  return cfg?.runnable ? [...engines, SYSTEM_ONE_CAPABILITY] : engines;
}
```

In `api/server.js` at the `advertisementTxt({…})` call (~L10098), change

`capability: capabilityFrom({ ...hardware, engines: installedEngines() }),`

to

`capability: capabilityFrom({ ...hardware, engines: advertisedEngines(installedEngines(), decisionConfig()) }),`

Then add `advertisedEngines` to the `./decision.js` import.

Run: `node --test api/decision.test.js api/fleet-advertisement.test.js && node --check api/server.js`. Expected: PASS.

- [ ] **Step 3: Write the failing UI helper test**

`ui/src/pages/decision-card.test.js`:

```js
// Llama Manager decision engine card helper tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies which lifecycle action the dashboard offers on the Decision (Laya)
// server card: Stop while it runs, Start when idle-but-runnable, nothing when
// it is disabled or unrunnable, and nothing for any other server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionCardAction } from './decision-card.js';

test('running decision engine offers Stop', () => {
  assert.deepEqual(decisionCardAction({ id: 'decision', state: 'running', running: true }), { label: 'Stop', path: '/decision/stop' });
});

test('idle runnable decision engine offers Start', () => {
  assert.deepEqual(decisionCardAction({ id: 'decision', state: 'idle', running: false }), { label: 'Start', path: '/decision/start' });
});

test('disabled decision engine and other servers offer nothing', () => {
  assert.equal(decisionCardAction({ id: 'decision', state: 'down', running: false, enable: { eligible: false } }), null);
  assert.equal(decisionCardAction({ id: 'llama', state: 'running', running: true }), null);
});
```

Run: `cd ui && node --test src/pages/decision-card.test.js`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement the helper**

`ui/src/pages/decision-card.js`:

```js
// Llama Manager decision engine card helper.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Pure helper for the dashboard's server registry: chooses the lifecycle button
// shown on the Decision (Laya) card — Stop while the container runs, Start when
// it is idle but runnable (it also starts lazily on the first request) — and
// returns null for a disabled engine or any other server card.

/**
 * @param {{id:string, state:string, running:boolean}} srv A /api/stats servers[] entry.
 * @returns {{label:'Start'|'Stop', path:string}|null} API path relative to API_BASE.
 */
export function decisionCardAction(srv) {
  if (srv?.id !== 'decision') return null;
  if (srv.running) return { label: 'Stop', path: '/decision/stop' };
  if (srv.state === 'idle') return { label: 'Start', path: '/decision/start' };
  return null;
}
```

Run: `cd ui && node --test src/pages/decision-card.test.js`. Expected: PASS.

- [ ] **Step 5: Render it in `ui/src/pages/Dashboard.jsx`**

1. Import: `import { decisionCardAction } from './decision-card.js';`
2. Icon line (~L1194): replace with
   ```jsx
   const icon = srv.type === 'ds4' ? '\u{1F9EC}' : srv.role === 'embeddings' ? '\u{1F9EE}' : srv.role === 'decision' ? '\u{2696}\u{FE0F}' : '\u{1F680}';
   ```
3. In the `sub` chain, before the final fallback `: \`${modelSummary}…\``, add a branch:
   ```jsx
   : (srv.id === 'decision' && srv.enable && !srv.running)
     ? srv.enable.reason
   ```
4. Replace the `return (<StatCard … />);` with:

```jsx
                const action = decisionCardAction(srv);
                return (
                  <div key={srv.id} className="server-registry-item">
                    <StatCard label={srv.displayName} value={stateLabel}
                      subValue={sub} icon={icon} status={status} />
                    {action && (
                      <button className="btn-secondary glass-btn"
                        onClick={() => fetch(`${API_BASE}${action.path}`, { method: 'POST' }).catch((err) => console.error('decision action failed:', err))}>
                        {action.label}
                      </button>
                    )}
                  </div>
                );
```

The stats websocket refreshes the card state within `STATS_INTERVAL`.

Run: `cd ui && npm test && npm run build`
Expected: tests pass and the vite build succeeds.

Visual check: this happens after T6's `./install.sh`. Open `http://localhost:5250/` → Dashboard → Servers. Expect the "Decision (Laya)" card. Playwright is unreliable in this shell, so ask the operator to eyeball it and record the result.

- [ ] **Step 6: Commit**

```bash
git add api/decision.js api/decision.test.js api/server.js ui/src/pages/decision-card.js ui/src/pages/decision-card.test.js ui/src/pages/Dashboard.jsx
git commit -F LastChange.md   # "feat(decision): advertise system_one to the fleet and add the Decision dashboard card"
```

---

### Task 5: ISO persistence (defaults, directories, image delivery)

**Files:**
- Modify: `packaging/llama-manager.tmpfiles`
- Modify on the **preload branch only** (image ≤ 2 GiB per T0), in submodule `distribution/ubuntu-respin` (its own repo and commits): `config/assets.lock`, `scripts/build-package-payload.sh` (AMD block ~L185-199), `debian/llama-manager-rocm-gfx1151.postinst`, `debian/llama-manager-rocm-gfx1151.prerm`, `tests/test-maintainer-scripts.sh`, `tests/test-package-payload.sh`
- Test: `tests/package-core/run-tests.sh` (existing), `distribution/ubuntu-respin/tests/run.sh`

**Interfaces:**
- Consumes (T1):
  - `DECISION_DEFAULTS` (`enabled:false` plus the pinned image). It reaches the ISO through `config/app-source.lock` (`ref main`) with no respin change.
  - `resolveRuntimePaths().decisionDir`.
- Produces: `/var/lib/llama-manager/decision` on every appliance, and the image available to the `llama-manager` user's rootless store (preloaded, or lazily pulled by `podman run --pull=missing`).

- [ ] **Step 1: Write the failing tmpfiles check**

`tests/package-core/run-tests.sh` greps packaging files. Add, next to the other tmpfiles assertions:

```bash
assert_equals "tmpfiles creates the decision weights cache" \
  "$(grep -c '^d /var/lib/llama-manager/decision 2770 llama-manager llama-manager -$' "$REPO_ROOT/packaging/llama-manager.tmpfiles")" "1"
```

If `assert_equals` is not defined in that file, first check the existing helper names with `grep -n '^assert' tests/package-core/run-tests.sh` and use the existing one with the same three arguments.

Run: `bash tests/package-core/run-tests.sh`
Expected: `FAIL tmpfiles creates the decision weights cache`.

- [ ] **Step 2: Add the directory**

Append to `packaging/llama-manager.tmpfiles`, after the `d /var/lib/llama-manager/ds4 …` line:

```
# Laya decision engine weights (HF cache mounted at laya-server's /data).
d /var/lib/llama-manager/decision 2770 llama-manager llama-manager -
```

Run: `bash tests/package-core/run-tests.sh`. Expected: all `ok`.

- [ ] **Step 3: Commit (app repo)**

```bash
git add packaging/llama-manager.tmpfiles tests/package-core/run-tests.sh
git commit -F LastChange.md   # "feat(decision): package-owned decision weights cache directory"
```

- [ ] **Step 4: Image delivery. Registry branch (T0 chose `ghcr.io/...@sha256:…`)**

- No respin change. `podman run --pull=missing` (T1 `podmanRunArgs`) pulls the digest on first start into `/var/lib/llama-manager/.local/share/containers`, as the service user. It is idempotent and never done by a maintainer script, so `test-maintainer-scripts.sh:39` holds.
- T6 pre-warms it by calling `POST /api/decision/start` from the deploy script.
- Record in the W6-T5 task: "registry branch; no ISO bytes added; offline appliances cannot start DECISION until online once".
- Skip Steps 5–8.

- [ ] **Step 5: Preload branch. Add the asset row** (`distribution/ubuntu-respin/config/assets.lock`)

```bash
podman save --format oci-archive -o /tmp/laya-server-<VARIANT>.oci.tar localhost/laya-server:<winning tag>
stat -c %s /tmp/laya-server-<VARIANT>.oci.tar        # → <TAR_BYTES>
sha256sum /tmp/laya-server-<VARIANT>.oci.tar          # → <TAR_SHA256>
```

Append one tab-separated row after `llama-rocm-7.2.4-oci`:

```
laya-server-<VARIANT>-oci	oci-image	github.com/noahbclarkson/laya-server	<LAYA_SERVER_SHA>	laya-server-<VARIANT>.oci.tar	<TAR_BYTES>	<TAR_SHA256>	MIT	local-build://laya-server@<LAYA_SERVER_SHA>?TORCH_INDEX=<rocm7.2|cu130>
```

Stage the tar wherever the respin's `verify-asset-locks.sh` reads `llama-rocm-7.2.4.oci.tar` from:

```bash
grep -n 'llama-rocm-7.2.4.oci.tar' distribution/ubuntu-respin/scripts/*.sh
```

Copy the tar to that same directory.

- [ ] **Step 6: Preload branch. Write the failing respin tests**

In `distribution/ubuntu-respin/tests/test-maintainer-scripts.sh`, after the `podman load` check (line 47):

```bash
grep -q 'laya-server-.*\.oci\.tar' "$rocm_post" || fail "decision image must be imported offline"
grep -q 'DECISION_IMAGE_ID=' "$rocm_post" || fail "decision image id must be pinned"
```

In `tests/test-package-payload.sh`, next to the `llama-rocm-7.2.4.oci.tar` payload assertion:

```bash
[ -f "$STAGE/llama-manager-rocm-gfx1151/usr/lib/llama-manager/offline/laya-server-<VARIANT>.oci.tar" ] || fail "decision image archive missing from payload"
```

Run: `(cd distribution/ubuntu-respin && tests/run.sh)`
Expected: FAIL on the new lines.

- [ ] **Step 7: Preload branch. Payload + postinst + prerm**

`scripts/build-package-payload.sh`:
- After `cp -a "$rocm_archive" …llama-rocm-7.2.4.oci.tar`, add
  ```bash
  cp -a "$decision_archive" "$rocm/usr/lib/llama-manager/offline/laya-server-<VARIANT>.oci.tar"
  ```
- Where `rocm_archive` is resolved from the asset id (`grep -n 'rocm_archive=' scripts/build-package-payload.sh`), add the same resolution for id `laya-server-<VARIANT>-oci` into `decision_archive`.

`debian/llama-manager-rocm-gfx1151.postinst`:
- After the `IMAGE_ID=` line, add:
  ```sh
  DECISION_ARCHIVE='/usr/lib/llama-manager/offline/laya-server-<VARIANT>.oci.tar'
  DECISION_IMAGE_ID='<image id without sha256: prefix>'
  ```
- After the ROCm image-id check, add:

```sh
  run_manager podman load -i "$DECISION_ARCHIVE"
  decision_actual="$(run_manager podman image inspect "sha256:$DECISION_IMAGE_ID" --format '{{.Id}}')"
  [ "${decision_actual#sha256:}" = "$DECISION_IMAGE_ID" ] || {
    printf 'Imported decision image ID mismatch: expected %s, got %s\n' "$DECISION_IMAGE_ID" "$decision_actual" >&2
    exit 1
  }
```

`podman load` is idempotent: reloading an identical image is a no-op.

`debian/llama-manager-rocm-gfx1151.prerm`: next to the existing `podman image rm`, add
```sh
run_manager podman image rm -f "sha256:<image id>" 2>/dev/null || true
```
Mirror the existing line's exact form.

Run: `(cd distribution/ubuntu-respin && tests/run.sh)`. Expected: PASS.

- [ ] **Step 8: Preload branch. Commit in the submodule, then bump the pointer**

```bash
git -C distribution/ubuntu-respin add config/assets.lock scripts/build-package-payload.sh debian/llama-manager-rocm-gfx1151.postinst debian/llama-manager-rocm-gfx1151.prerm tests/test-maintainer-scripts.sh tests/test-package-payload.sh
git -C distribution/ubuntu-respin commit -F ../../LastChange.md   # "feat(decision): preload the pinned laya-server image offline"
git -C distribution/ubuntu-respin push origin HEAD:main
git add distribution/ubuntu-respin
git commit -F LastChange.md   # "chore(respin): bump for the decision image preload"
```

The respin push is its own repo. It uses a plain push because the respin has no worktree-merge helper. If it is rejected, run `git -C distribution/ubuntu-respin pull --rebase origin main` and push again.

- [ ] **Step 9: Verify the ISO path carries the code**

```bash
cat distribution/ubuntu-respin/config/app-source.lock     # expect: url …WebLlamaManager, ref main
```

After T6 lands, `main` contains `api/decision*.js` and the tmpfiles line, so the next ISO build (`R/ci/build-app-dependency.sh` clones `ref main`) includes them. Record in the W6-T5 task: "next ISO build from main ≥ <landed sha> includes DECISION; defaults enabled:false".

---

### Task 6: Land, deploy to Frostburn (dev) and drakemore (appliance), persist config, smoke

**Files:**
- Create: `scripts/decision-enable.sh`, `tests/decision/run-tests.sh`, `docs/features/decision-engine.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces:
  - running engines on both hosts
  - the Frostburn `laya` alias base URL `http://frostburn:5250/api/v1/systemone`, which W7-T4 uses as the orchestrator Laya provider base URL `http://<frostburn-host>:5250/api`
  - smoke evidence

- [ ] **Step 1: Write the failing script test**

`tests/decision/run-tests.sh`:

```bash
#!/bin/bash
# Llama Manager — tests for scripts/decision-enable.sh.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Verifies the persistent decision-engine enable script builds the exact config
# JSON it will POST to the loopback /api/decision/config endpoint, without any
# network access (--print seam), and rejects a missing API base.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/decision-enable.sh"
failures=0
assert_equals() { local d="$1" a="$2" e="$3"
  if [[ "$a" == "$e" ]]; then printf '  ok   %s\n' "$d"; else printf '  FAIL %s\n    expected: %s\n    actual:   %s\n' "$d" "$e" "$a"; failures=$((failures + 1)); fi; }

assert_equals "minimal enable body" \
  "$("$SCRIPT" --print http://127.0.0.1:3001)" \
  '{"enabled":true}'
assert_equals "gpu pool and peer" \
  "$("$SCRIPT" --print http://127.0.0.1:5250 --gpu rocm-igpu --peer drakemore=http://192.168.1.79:3001)" \
  '{"enabled":true,"gpu":"rocm-igpu","peers":[{"name":"drakemore","url":"http://192.168.1.79:3001"}]}'
"$SCRIPT" --print >/dev/null 2>&1; assert_equals "missing api base exits 2" "$?" "2"

[ "$failures" -eq 0 ] || { printf '%d failure(s)\n' "$failures"; exit 1; }
```

Run: `bash tests/decision/run-tests.sh`
Expected: FAIL (the script does not exist).

- [ ] **Step 2: Write `scripts/decision-enable.sh`**

```bash
#!/bin/bash
# Llama Manager — persistently enable the System 1 decision engine on this node.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Enables the laya DECISION engine through the manager's loopback-only
# POST /api/decision/config, which persists into the active config.json
# (/etc/llama-manager/config.json on appliances, the checkout's config.json in
# source mode), then warms the engine with POST /api/decision/start (first run
# pulls the pinned image and downloads the checkpoint) and prints the status.
# Never hand-edit config.json for this; rerunning is idempotent.
#
# Usage: decision-enable.sh [--print] <api-base> [--gpu <pool>] [--peer <name>=<url>]...
#   --print   print the JSON body and exit (test seam; no network).
set -euo pipefail

print=0
[ "${1:-}" = "--print" ] && { print=1; shift; }
base="${1:-}"
[ -n "$base" ] || { echo "usage: decision-enable.sh [--print] <api-base> [--gpu <pool>] [--peer <name>=<url>]..." >&2; exit 2; }
shift

gpu=""
peers=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) gpu="$2"; shift 2 ;;
    --peer) name="${2%%=*}"; url="${2#*=}"; peers="${peers:+$peers,}{\"name\":\"$name\",\"url\":\"$url\"}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

body='{"enabled":true'
[ -n "$gpu" ] && body="$body,\"gpu\":\"$gpu\""
[ -n "$peers" ] && body="$body,\"peers\":[$peers]"
body="$body}"

if [ "$print" = 1 ]; then printf '%s\n' "$body"; exit 0; fi

curl -sf -X POST "$base/api/decision/config" -H 'content-type: application/json' -d "$body" >/dev/null
echo "config persisted; starting (first start may pull the image and download weights)…"
curl -s -m 1800 -X POST "$base/api/decision/start"; echo
curl -s "$base/api/decision/status"; echo
```

```bash
chmod +x scripts/decision-enable.sh
bash tests/decision/run-tests.sh
```

Expected: three `ok` lines.

- [ ] **Step 3: Write the operator doc** `docs/features/decision-engine.md`

Include:
- what the engine is (laya-server container, :5254 loopback, Jev wire);
- the `config.decision` keys table (from `DECISION_DEFAULTS`);
- the endpoints and the `x-laya-host`/`x-laya-hop` headers;
- routing order and memory guard;
- the T0 decision record (variant, latencies, image ref);
- enable via `scripts/decision-enable.sh`;
- ISO delivery branch.

Run `orch docs sync --json` after the doc lands on main.

Commit:

```bash
git add scripts/decision-enable.sh tests/decision/run-tests.sh docs/features/decision-engine.md
git commit -F LastChange.md   # "feat(decision): scripted persistent enable + operator doc"
```

- [ ] **Step 4: Gate and land (lands on `main` and deploys the code to BOTH boxes)**

```bash
cd /home/yolan/workspace/ai/llama-server/.claude/worktrees/laya-decision
node --test api/*.test.js 2>&1 | grep -E '^# (pass|fail)'     # expect "# fail 2" (known dev-config pair)
node --check api/server.js
(cd ui && npm test)
bash tests/decision/run-tests.sh
bash tests/package-core/run-tests.sh
git log --oneline main..HEAD                                   # the SHAs to land, oldest first
cd /home/yolan/workspace/ai/llama-server
~/bin/llama-land-and-deploy.sh <sha1> <sha2> <sha3> …           # paste the literal SHAs
```

The helper:
- runs the gates;
- lands through `worktree-merge.sh` (lock plus retry);
- runs `./install.sh` on Frostburn (vite build + restart);
- scps the **whole** `api/*.js` and `ui/dist` to drakemore, restarts it, and checks module errors = 0.

Expected tail: `done — origin/main = <sha>; both boxes serving`.

The helper does **not** copy `scripts/`, so ship the enable script to the appliance explicitly:

```bash
scp scripts/decision-enable.sh drakemore:/usr/lib/llama-manager/scripts/decision-enable.sh
drakemore ssh 'chmod 755 /usr/lib/llama-manager/scripts/decision-enable.sh; chown root:root /usr/lib/llama-manager/scripts/decision-enable.sh'
drakemore ssh 'systemd-tmpfiles --create /usr/lib/tmpfiles.d/llama-manager.conf || install -d -o llama-manager -g llama-manager -m 2770 /var/lib/llama-manager/decision'
```

The tmpfiles line only reaches `/usr/lib/tmpfiles.d` with the next package, so the `install -d` fallback covers today.

On the OCI-tar branch, the image must also be in the service user's store now. It was loaded in T0 step 5. Confirm:

```bash
drakemore ssh 'runuser -u llama-manager -- env HOME=/var/lib/llama-manager XDG_RUNTIME_DIR=/run/llama-manager podman image exists <DECISION_IMAGE> && echo present'
```

- [ ] **Step 5: Enable persistently on drakemore (preferred host)**

```bash
drakemore ssh '/usr/lib/llama-manager/scripts/decision-enable.sh http://127.0.0.1:3001 --gpu <GPU_POOL>'
drakemore ssh 'grep -c "\"decision\"" /etc/llama-manager/config.json'          # → 1 (persisted, not hand-edited)
drakemore restart                                                               # module-errors=0; config survives restart
drakemore ssh 'curl -s localhost:3001/api/decision/status'                     # enabled:true, runnable:true, available:true
```

- [ ] **Step 6: Enable on Frostburn with drakemore as the preferred peer**

```bash
cd /home/yolan/workspace/ai/llama-server
./scripts/decision-enable.sh http://127.0.0.1:5250 --peer drakemore=http://192.168.1.79:3001
curl -s localhost:5250/api/decision/status
```

Frostburn's own engine is the lazy fallback. Stop it now so the alias demonstrably prefers drakemore:

```bash
curl -s -X POST localhost:5250/api/decision/stop
```

- [ ] **Step 7: Smoke. Every contract clause, with recorded output**

```bash
# 1. drakemore direct: served locally, header = drakemore's node name
drakemore ssh 'curl -s -D - -o /dev/null localhost:3001/v1/systemone -H "content-type: application/json" -d "{\"model\":\"laya\",\"state\":\"Invoice INV-1 total 40 NZD\",\"questions\":{\"q\":{\"type\":\"noul\",\"instructions\":\"Is this an invoice?\"}}}" | grep -i -E "^HTTP|x-laya-host"'
# 2. Frostburn alias → drakemore (expect x-laya-host: drakemore's name; Frostburn engine stays stopped)
node scripts/decision-bench.mjs http://127.0.0.1:5250/api 10
curl -s localhost:5250/api/decision/status          # running:false; peers[0].available:true
# 3. jev-* model name accepted
curl -s -o /dev/null -w '%{http_code}\n' localhost:5250/api/v1/systemone -H 'content-type: application/json' -d '{"model":"jev-latest","state":"x","questions":{"q":{"type":"noul","instructions":"Is x a letter?"}}}'   # 200
# 4. non-decision model rejected
curl -s -w ' %{http_code}\n' localhost:5250/api/v1/systemone -H 'content-type: application/json' -d '{"model":"default-big","state":"x","questions":{}}'   # unsupported_model 400
# 5. drakemore down → Frostburn local fallback (lazy start)
drakemore ssh 'curl -s -X POST localhost:3001/api/decision/config -H "content-type: application/json" -d "{\"enabled\":false}"'
sleep 11                                              # > peerHealthTtlMs
node scripts/decision-bench.mjs http://127.0.0.1:5250/api 5    # host = Frostburn's name
# 6. both unavailable → 503 no_decision_host
curl -s -X POST localhost:5250/api/decision/config -H 'content-type: application/json' -d '{"enabled":false}'
curl -s -D - localhost:5250/api/v1/systemone -H 'content-type: application/json' -d '{"model":"laya","state":"x","questions":{"q":{"type":"noul","instructions":"?"}}}' | grep -i -E '^HTTP|x-laya-host|no_decision_host'
# 7. restore
drakemore ssh '/usr/lib/llama-manager/scripts/decision-enable.sh http://127.0.0.1:3001 --gpu <GPU_POOL>'
./scripts/decision-enable.sh http://127.0.0.1:5250 --peer drakemore=http://192.168.1.79:3001
curl -s -X POST localhost:5250/api/decision/stop
# 8. fleet advertisement carries system_one
drakemore ssh 'grep -o "engines=[^<]*" /etc/avahi/services/llama-manager.service'   # contains system_one
# 9. idle-out: after idleTimeoutSec (600 s) with no traffic, drakemore status running:false
```

Clause 9 is asynchronous. Check `drakemore ssh 'curl -s localhost:3001/api/decision/status'` ≥ 10 minutes after the last smoke call, and record the result.

The `decision-bench.mjs` base `http://127.0.0.1:5250/api` posts to `/api/v1/systemone`, the path the orchestrator will use.

- [ ] **Step 8: Record and close**

```bash
orch tasks progress <W6-T6 id> "landed <sha range> on WebLlamaManager main; frostburn + drakemore deployed (module-errors=0); drakemore decision enabled via decision-enable.sh (persisted in /etc/llama-manager/config.json); frostburn peers=[drakemore]; smoke 1-9: <paste codes/hosts/latencies>; alias base for W7-T4: http://<frostburn>:5250/api; next: W7-T4" --json
orch tasks add-diff <W6-T6 id> <sha> "<title>" --json      # one per landed commit
```

Complete the W6 task only once every smoke line has recorded output.

---

## Contract deltas vs master §1.5 (additive; no renames)

1. **Extra `decision` keys:** `device`, `podmanArgs`, `startTimeoutSec`, `minFreeMemBytes`, `peers`, `peerHealthTtlMs` and `forwardTimeoutMs`. `gpu` is recorded and reported only.
   - The engine does **not** take a `gpu-reservations` hold. Reservations are exclusive per-card holds, and a 1.5 GB sidecar must coexist with the resident LLM on the same card.
   - GPU pinning is done by the spike-chosen `podmanArgs`/`device`.
2. **Extra routes:** `POST /api/decision/start|stop` (dashboard card) and `POST /api/decision/config` (loopback-only, used by the enable script).
3. **Extra header:** `x-laya-hop` (request header, loop guard).
4. **Container port is 8765 internally**, mapped to host `127.0.0.1:5254`. Peers reach it only through llama-manager's `/api/v1/systemone` on :3001 (drakemore) or :5250 (Frostburn).
5. **The image is self-built.** laya-server publishes no image. "Pinned by digest" means a ghcr repo digest (registry branch) or a full local image id (OCI-tar preload branch).
6. **`GET /v1/models` for the decision model is not added.** The spec §4.5 mentioned it, but §1.5 does not. The model shows up in the `/api/stats` server registry as `laya-<checkpoint>`. Add it only if W7 needs it.
7. **The routing order uses only operator-configured peers before local.** Discovered fleet peers resolve names; they are not auto-preferred. This avoids drakemore→Frostburn preference and hop loops.

## Self-review notes

- **Spec coverage:**

  | Spec item | Covered by |
  |---|---|
  | Engine type, container, digest pin, :5254 | T1 |
  | Lazy start and idle timeout | T1 supervisor |
  | Config defaults `enabled:false` | T1 `DECISION_DEFAULTS` |
  | Weights cache (packaged and source) | T1 runtime-paths |
  | Proxy for both paths, status, `x-laya-host` | T2 |
  | Registry/status entry | T1 step 11 |
  | Alias: drakemore → local (memory guard) → 503 | T3 |
  | Fleet `system_one` | T4 |
  | UI card | T4 |
  | ISO: app-source.lock + defaults + dir + image delivery | T5 |
  | drakemore config via script | T6 |
  | Smoke | T6 |
  | Spike (latency 1/5/10, VRAM, coexistence, pool) | T0 |

- **Placeholders:** the only placeholders are the T0-table symbols (`<DECISION_IMAGE>`, `<PODMAN_GPU_ARGS>`, `<DEVICE>`, `<GPU_POOL>`, `<MIN_FREE_BYTES>`, `<VARIANT>`, `<LAYA_SERVER_SHA>`, `<IMAGE_BYTES>`), plus literal SHAs/ids pasted from command output. Each has a fill rule.
- **Names:** `resolveDecisionConfig`, `podmanRunArgs`, `createDecisionSupervisor`, `createDecisionRouter`, `planDecisionRoute`, `resolvePeers`, `peerOffersDecision`, `advertisedEngines`, `decisionCardAction`, `decisionDir` and `ENGINE_TYPES.DECISION` are used consistently across T1–T6.
