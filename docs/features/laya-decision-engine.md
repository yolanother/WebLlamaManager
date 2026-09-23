<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Documents the System 1 DECISION engine: what Jev and Laya are and why llama-manager
hosts Laya, the Jev-compatible /v1/systemone API and its model-name rewrite, the
`laya` alias route (configured peers first, then the local engine behind a memory
guard, else 503), the supervised laya-server Podman container and its host pid/net
loopback posture, every `config.decision` key and DECISION_* env override
(including DECISION_DEFAULT_ENABLED and the ROCm/CUDA variant + GPU selection), how
the pinned image is built on Frostburn and shipped in the llama-manager-laya-rocm
deb so a reimaged appliance serves it on first boot, the orchestrator side (the
system_one provider row and node-proxy latency), measured latency, and operations.
-->

# Laya DECISION engine (System 1)

llama-manager hosts **Laya**, a small classifier that answers typed questions about
a piece of state ("is this passage relevant?", "which of these tools fits?"). It is
the self-hosted twin of **Jev**, typesafe.ai's hosted "System 1" API. The
orchestrator uses one of them — switchable in its settings — to rerank knowledge
search results, route MCP tools, triage prompts and gate task-reporting hooks. Jev
is the default because it is on trial and stable; Laya exists so the orchestrator
can switch off Jev's per-token bill without losing the feature.

| | Jev | Laya |
|---|---|---|
| Where | `https://api.typesafe.ai/v1/systemone` | llama-manager `/v1/systemone` (this doc) |
| Model | `jev-latest` | ModernBERT 421M `typed-decisions` checkpoint via [laya-server](https://github.com/noahbclarkson/laya-server) |
| Cost | $0.042 / 1M input tokens, output free | free (runs on the appliance GPU) |
| Wire format | Jev JSON: `{model, state, questions}` → `{model, answers, usage}` | same (laya-server's Jev alias) |

Question types are `noul` (a probability), `choice` (pick from `criteria`) and
`score`. A request is one `state` plus a map of named questions:

```json
POST /api/v1/systemone
{"model":"laya","state":"The user asked to list files in the repo.",
 "questions":{"tool":{"type":"choice","question":"Which tool fits?","criteria":["ls","rm"]}}}

200 {"model":"laya-typed-decisions",
     "answers":{"tool":{"type":"choice","choice":"ls","probabilities":{"ls":0.9043,"rm":0.0957},"confidence":0.5447}},
     "usage":{"input_tokens":22,"output_tokens":0},"host":"drakemore"}
```

## Routes

All in `api/decision-router.js`; pure policy in `api/decision.js`.

| Route | Who | What |
|---|---|---|
| `POST /v1/systemone`, `POST /api/v1/systemone` | anyone on the LAN | Answer a Jev-wire request (see routing below). 400 `unsupported_model` for a chat model name; 503 `no_decision_host` when nothing can serve. |
| `GET /api/decision/status` | anyone | Config (`enabled`, `runnable`, `reason`, `image`, `variant`, `gpus`, `checkpoint`, `port`, …), supervisor state, peer health. Peers call it to see whether a Laya host is `available`. |
| `POST /api/decision/start`, `/stop` | dashboard | Start/stop the container now. |
| `POST /api/decision/config` | **loopback only** (403 `NOT_LOOPBACK` off-box) | Merge whitelisted `decision` keys into `config.json` and return the resolved config. |

**Model names.** `laya`, `laya-*`, `jev-*` and an omitted model are accepted.
llama-manager rewrites all of them to `laya-<loaded checkpoint>` (normally
`laya-typed-decisions`) before forwarding, because laya-server itself maps a bare
`laya` to `laya-english` and 422s when that checkpoint isn't loaded. So the
orchestrator can send `jev-latest` to Laya unchanged.

**Which host answered.** Every response carries the serving node in both the
`x-laya-host` header and a `host` field in the JSON body — the orchestrator's
node-proxy transport drops response headers, so the body field is the one it reads.

## The `laya` alias: drakemore first, Frostburn as fallback

Each request walks an ordered target list and returns the first non-5xx answer:

1. **Configured peers**, in order (`decision.peers`), skipping any whose
   `/api/decision/status` did not report `available` in the last
   `peerHealthTtlMs`. A forwarded request carries `x-laya-hop` and is never
   forwarded again, so two hosts pointing at each other cannot loop.
2. **The local engine**, if it is runnable and either already running or
   `MemAvailable ≥ minFreeMemBytes` (6 GiB: measured peak RSS 2.7 GB + VRAM
   1.68 GB, doubled) so a cold start cannot push a busy host into OOM.
3. Otherwise **503 `no_decision_host`**.

Current fleet: Frostburn runs the alias with
`{"enabled":true,"peers":[{"name":"drakemore","url":"http://192.168.1.79:3001"}]}`,
so Laya lands on drakemore and falls back to Frostburn's own engine when drakemore
is down and Frostburn has memory. drakemore serves locally. A peer can also be
named without a URL (`{"name":"drakemore"}`) — it is then resolved from mDNS
peers that advertise the `system_one` engine token, which a node adds to its
advertised engines only while its own engine is runnable.

## The container

`api/decision-supervisor.js` runs **one** laya-server container,
`llama-manager-decision`, started lazily on the first request and stopped after
`idleTimeoutSec` (600 s) without use; the next request starts it again (cold start
≈ 25 s on drakemore, weights cached under the runtime `decision` dir, e.g.
`/var/lib/llama-manager/decision`, mounted at `/data`). There is no auto-restart:
an exit marks the engine down until the next request.

`podmanRunArgs()` builds the argv. Two choices are deliberate:

- **Host pid + host network, bound to loopback.** The appliance's rootless podman
  cannot give a container its own proc/net namespace — crun fails with
  `mount proc … Operation not permitted` and
  `ping_group_range: Read-only file system` (exit 126). This is the same reason the
  ROCm engine's distrobox runs host pid/net. So the container shares them and
  laya-server binds `127.0.0.1:<port>` itself (`LAYA_SERVER_HOST`/`_PORT`); peers
  reach it only through llama-manager's proxy. It stays unprivileged
  (`--userns=keep-id:uid=1000,gid=1000`). Operator-approved on 2026-09-22.
- **Pinned image only.** `resolveDecisionConfig` refuses (`runnable:false`,
  `reason:"image is not pinned by digest"`) any image that is not a repo digest
  or a full `sha256:` image id, so a tag can never silently change the model.

## Configuration

`config.decision` in `config.json` (every key below is settable through
`POST /api/decision/config`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` (see `DECISION_DEFAULT_ENABLED`) | Serve Laya from this node. |
| `variant` | `"rocm"` | `rocm` or `cuda` — which GPU stack the container runs under. |
| `gpus` | `[]` | Device indices to expose; `[]` = all. ROCm → `HIP_VISIBLE_DEVICES=<list>`; CUDA → one CDI `--device nvidia.com/gpu=<n>` each (or `=all`). |
| `imageRocm` | the pinned Frostburn build | Image for `variant: rocm`. The legacy `image` key still sets it for older configs. |
| `imageCuda` | `""` | Image for `variant: cuda`. **Must be set to a pinned digest by the operator** — CUDA is refused (`reason: "no pinned CUDA image"`) until then; no CUDA image is built or shipped. |
| `checkpoint` | `typed-decisions` | `english`, `multilingual` or `typed-decisions`. |
| `device` | `cuda:0` | laya-server's torch device string (ROCm torch also calls the GPU `cuda`). |
| `podmanArgs` | gfx1151 set: `--device /dev/kfd --device /dev/dri --group-add keep-groups --security-opt seccomp=unconfined -e HSA_OVERRIDE_GFX_VERSION=11.5.1` | Extra `podman run` args. Dropped for `cuda` unless you set them. |
| `port` | `5254` | laya-server's loopback port. |
| `idleTimeoutSec` / `startTimeoutSec` | `600` / `900` | Stop after idle; give up waiting for `/healthz` on start. |
| `minFreeMemBytes` | 6 GiB | Memory guard for a local cold start. |
| `peers` | `[]` | Ordered `{name, url?}` alias targets. |
| `peerHealthTtlMs` / `forwardTimeoutMs` | `10000` / `15000` | Peer status cache; per-hop request timeout. |

Environment overrides: `DECISION_ENABLED=true|false` and `DECISION_PORT` override
the block. `DECISION_DEFAULT_ENABLED=true` only replaces the shipped `false`
default — an explicit `config.decision.enabled` still wins — and is set by the Laya
package's service drop-in (below), so the operator's off switch is never
overridden by packaging.

The dashboard's Decision (Laya) card shows the engine, a Start/Stop button, and
a ROCm/CUDA selector plus GPU list that read the saved values from
`/api/decision/status` and write through the loopback config route.

## How it is built and shipped

**Frostburn builds; drakemore receives.** drakemore can be reimaged from
Frostburn's ISO at any time, so nothing is built or hand-installed there — every
piece must arrive through the ISO or the APT repo.

1. `scripts/decision-build-image.sh` (Frostburn only) builds
   `packaging/decision/Containerfile` — upstream laya-server pinned to commit
   `819fa06`, plus `libatomic1` (upstream's slim base lacks it and ROCm torch fails
   to import without it) and with every non-gfx1151 hipBLASLt/rocBLAS kernel
   stripped *in the same layer* as the pip install (≈16 GB → a few GB). It checks
   that `check_gpu.py` inside the image sees gfx1151, then exports a zstd OCI
   archive to `/volumes/llama-manager/assets/laya/` (current:
   `laya-server-4f5c0f0-rocm.oci.tar`, image id
   `sha256:3b6dd0d5cb3c…`, which is `DEFAULT_DECISION_IMAGE`).
2. The respin repo packages that archive as **`llama-manager-laya-rocm`**: the
   archive, a first-boot `llama-manager-laya-setup.service` that `podman load`s it
   (a maintainer-script `podman load` does not work inside the ISO build chroot),
   and a `llama-manager.service` drop-in (`60-laya-setup.conf`) with
   `Wants=`/`After=` on the setup unit and
   `Environment=DECISION_DEFAULT_ENABLED=true`. `llama-manager-appliance` Depends
   on it, so every AMD appliance install and every ISO carries Laya, loaded and on.
3. The release watcher on Frostburn builds, signs and publishes the debs + ISO to
   the NAS and syncs thromgar. First release to carry Laya: `18ef264`
   (2026-09-23); default-on since `cd8bc3d`.

## Latency

Measured with `node scripts/decision-bench.mjs <base-url>` (20 iterations,
`noul` questions), 2026-09-22:

| Path | 1 q p50 / p95 | 5 q | 10 q |
|---|---|---|---|
| Frostburn alias → drakemore (warm, gfx1151) | 50.7 / 54.4 ms | 103.4 / 241.4 ms | 184.3 / 327.9 ms |
| Frostburn local engine (gfx1151, stripped image) | — | — | 243 ms p50 |

From the **production orchestrator** the path is different: prod reaches Frostburn
only through its node-proxy, which was heartbeat-polled (~6.6 s added per call, p50
≈ 9.6 s in the prod eval). The orchestrator's long-poll pickup
(`GET /api/v1/nodes/:id/proxy-requests`) removes that once the Frostburn node runs
the updated `headless-node.mjs`. Until then live Laya calls from prod exceed their
600–800 ms budgets and the orchestrator falls back to its baseline answer.

## The orchestrator side

The orchestrator talks to Laya through a `system_one` provider row (Settings →
Models): base URL `http://llama.lair.jaxns.net/api` (it appends `/v1/systemone`),
routing target = the Frostburn node. Settings `system1.provider`
(`off`|`jev`|`laya`), `system1.fallback`, per-use-case `system1.modes`
(`off`|`shadow`|`on`) and the monthly Jev budget decide when it is used. Its
design lives in the orchestrator repo:
`docs/Designs/Knowledge/system1-decision-layer.md`.

First prod eval of Laya (2026-09-23, recorded in the orchestrator's
`system1.lastEval`): triage 0.683 (n=41), enforcement gate 0.750 (n=20), tool
routing 0.158 (n=57 — weak, Laya sees only ~400 tokens of state so a long tool
catalogue is truncated). No Jev reference yet, so the Laya switch gate has not
passed.

## Operations

- **Is it serving?** `curl -s http://<node>:<api-port>/api/decision/status` (API port: 5250 on Frostburn, 3001 on appliances) — check
  `runnable`, `reason`, `running`, `peers[].available`.
- **Enable/disable on a node** (on the node itself — loopback only):
  `curl -s -X POST localhost:<api-port>/api/decision/config -H 'content-type: application/json' -d '{"enabled":false}'`.
- **Smoke:** `node scripts/decision-bench.mjs http://localhost:<api-port>/api 5`.
- **Tests:** `node --test api/decision.test.js api/decision-router.test.js api/decision-supervisor.test.js`
  and `node --test ui/src/pages/decision-card.test.js`.

See [GOTCHAS.md](../GOTCHAS.md#laya-decision-engine) for the failures we hit, and
the build plan in [`plans/2026-09-22-laya-decision-engine.md`](../plans/2026-09-22-laya-decision-engine.md).
