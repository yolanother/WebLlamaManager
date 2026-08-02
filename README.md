<img src="ui/public/favicon/favicon-96x96.png" alt="Llama Manager" align="left" width="64" height="64" style="margin-right: 16px;">

# Llama Manager

<img width="1500" height="1167" alt="image" src="https://github.com/user-attachments/assets/e57cad3c-8d95-45c3-a504-b984249f90aa" />

A comprehensive LLM management, debugging, and performance monitoring platform for local inference on AMD Strix Halo (gfx1151) GPUs. Provides a modern web UI with real-time GPU/CPU/memory telemetry, persistent historical analytics, request tracking with error breakdown, token throughput analysis, full conversation logging, and a hands-free fullscreen dashboard for wall-mounted monitoring. Runs **multiple inference engines** behind one OpenAI-compatible API — llama.cpp (multi-model router with on-demand loading and LRU eviction) and **DS4 / DeepSeek V4 Flash** (antirez/ds4) — with request-time model aliasing, smart remote offload, and a suite of stability guards tuned for a shared, thermally-constrained CPU+iGPU box.

> **New here?** Read [`docs/features-overview.md`](docs/features-overview.md) for the full feature map and [`docs/ds4-engine.md`](docs/ds4-engine.md) for the DeepSeek V4 Flash engine.

<br clear="left">

## Features

### Monitoring & Analytics
- **Real-time telemetry**: Live GPU temperature, power draw, VRAM/GTT usage, CPU load, and context utilization with 1-second resolution
- **Historical analytics**: Persistent minute-level data (JSONL, up to 1 year) with configurable time ranges (1H/1D/1W/1M/1Y) and automatic downsampling
- **Request tracking**: Per-request logging with status codes, latency, error messages, and stacked success/error volume charts
- **Token throughput**: Generation speed (tok/s) tracking across completions with historical trend analysis
- **Error breakdown**: Status code distribution bar charts for diagnosing API issues
- **Fullscreen dashboard**: Auto-paging, hands-free display mode for wall-mounted monitors with configurable cycle interval

### LLM Debugging
- **Conversation logging**: Full request/response capture for LLM API calls including messages, token counts, and timing
- **Request body inspection**: Detailed HTTP request/response logging with expandable error details
- **Process monitoring**: View and manage running llama-server processes with resource usage
- **Server log streaming**: Real-time log output with configurable noise filters

### Inference Engines & Routing
- **Multi-engine**: llama.cpp (router or single-preset) and **DS4 / DeepSeek V4 Flash** behind one abstraction — a preset picks its engine ([`docs/features-overview.md`](docs/features-overview.md))
- **DeepSeek V4 Flash**: an 80 GB model that upstream llama.cpp can't load, run on the iGPU via [antirez/ds4](https://github.com/antirez/ds4) with **adaptive context scaling + SSD expert-streaming** that fits it to the box, exclusive-mode pre-eviction, and a self-updater ([`docs/ds4-engine.md`](docs/ds4-engine.md))
- **Preferred big/small models**: `default-big` / `default-small` request-time aliases retarget your whole fleet centrally — migrate clients between models (and engines) with no client change
- **Smart remote offload**: forward requests to remote OpenAI-compatible backends (e.g. Ollama boxes) by queue depth, thermal state, or policy; protect-resident anti-thrash keeps the big model loaded; fastest-backend and backfill-race routing

### Model Management
- **Multi-model router**: Load and unload models dynamically without restarting, with LRU eviction
- **HuggingFace integration**: Search and download GGUF models with progress tracking
- **Optimized presets**: One-click configurations for specific models (custom sampling, chat templates, reasoning formats, speculative decoding)
- **Model aliases**: Friendly display names, plus the `default-big`/`default-small` routing aliases above
- **Dedicated embeddings server**: OpenAI-compatible `/v1/embeddings` on its own port

### Stability (Strix Halo hardening)
- **Memory watchdog, thermal governor, restart governor**: pause/offload/restart decisions tuned to the shared CPU+iGPU die and 124 GB unified RAM, each built from a real incident ([`docs/strix-halo-gpu-stability.md`](docs/strix-halo-gpu-stability.md))
- **Queue admission & slot reaper**: backpressure without dropping requests; leaked-slot recovery
- **KV-cache persistence**: per-slot prefix cache saved/restored across model reloads

### Infrastructure
- **OpenAI-compatible API**: Drop-in replacement proxy (`chat/completions`, `completions`, `embeddings`, `responses`, Anthropic-shaped `messages`, `rerank`) with automatic message sanitization for tool-call edge cases
- **MCP Server**: Integration with AI agents like Claude Desktop
- **Full Chat Interface**: Multi-conversation chat with streaming, code highlighting, and image support
- **systemd service**: Auto-start on boot, runs in background
- **Models stored in ~/models**: All llama.cpp models in one place (DS4 GGUFs live separately in `~/models-ds4`)

## Screenshots

<details>
<summary><strong>Dashboard</strong> - Server status, system resources, and performance analytics</summary>

![Dashboard](docs/screenshots/dashboard.png)
</details>

<details>
<summary><strong>Chat</strong> - Multi-conversation chat with streaming responses</summary>

![Chat](docs/screenshots/chat.png)
</details>

<details>
<summary><strong>Models</strong> - Load, unload, and manage local models</summary>

![Models](docs/screenshots/models.png)
</details>

<details>
<summary><strong>Presets</strong> - Optimized configurations for specific models</summary>

![Presets](docs/screenshots/presets.png)
</details>

<details>
<summary><strong>Download</strong> - Search and download models from HuggingFace</summary>

![Download Search](docs/screenshots/download-search.png)
![Download Files](docs/screenshots/download-files.png)
</details>

<details>
<summary><strong>Logs & Processes</strong> - Real-time server logs and process monitoring</summary>

![Logs](docs/screenshots/logs.png)
![Processes](docs/screenshots/processes.png)
</details>

<details>
<summary><strong>Documentation</strong> - In-app docs and API reference</summary>

![Docs](docs/screenshots/docs.png)
![API Docs](docs/screenshots/api-docs-openai.png)
</details>

## Requirements

For source checkouts:

- Node.js 18+
- distrobox with the ROCm 7.2.4 toolbox `llama-rocm-7.2.4` (image
  `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4`; selectable via
  `DISTROBOX_CONTAINER`). It ships a prebuilt `/usr/local/bin/llama-server` — no
  build step is required for normal operation.
- llama.cpp with ROCm support — provided prebuilt by the toolbox above (a custom
  build via `scripts/build-llama-cpp.sh` is optional). See
  [`docs/llama-cpp-rocm-build-and-deployment.md`](docs/llama-cpp-rocm-build-and-deployment.md).

The Debian package does not use Noble's system Node. It bundles Node 20.18.1 or
newer at `/usr/lib/llama-manager/node/bin/node` for reproducible offline installs;
the machine-readable builder contract is `packaging/runtime-contract.env`.

## Quick Start

This is the source-checkout installation flow. It preserves the current user's
paths and creates a per-user service:

```bash
# Install dependencies and build UI
./install.sh

# Enable service to start on boot
systemctl --user enable llama-manager

# Start the service
systemctl --user start llama-manager

# Access the web UI
# http://localhost:3001
```

Debian packages use a dedicated `llama-manager` system account, immutable code
under `/usr/lib/llama-manager`, signed APT upgrades, and the constrained
`llama-managerctl` interface. See
[Operating a packaged installation](docs/Utilities/package-installation.md).

## How It Works

Llama Manager sits in front of one or more inference engines and exposes a single
OpenAI-compatible API on port 5250 (`/api/v1`). A request flows:

```
client → /api/v1/chat/completions
  → resolve default-big/default-small alias → real model
  → route: local engine  OR  remote offload backend
       local llama.cpp (router or preset)  |  local DS4 (exclusive)  |  remote (Ollama, …)
```

By default the local engine is **llama.cpp in router mode**:

1. Models are auto-discovered from `~/models`
2. Multiple models can be loaded simultaneously (default: 2)
3. Models load on-demand when first requested
4. LRU eviction when hitting the max models limit
5. No server restart needed to switch models

On top of that:

- **Engines**: a preset can declare `engine: "ds4"` to serve DeepSeek V4 Flash
  instead of a llama.cpp model. DS4 runs *exclusively* (evicts everything else) and
  auto-fits itself via adaptive context + SSD-streaming — see
  [`docs/ds4-engine.md`](docs/ds4-engine.md).
- **Aliases**: point `default-big` / `default-small` at any model (or a DS4 preset)
  so clients get retargeted centrally — `POST /api/settings`.
- **Offload**: when the box is busy, hot, or running DS4, requests for other models
  are forwarded to configured remote backends (`/api/backends`).
- **Realtime context management**: local llama.cpp models expose exact rendered
  input counts, stable conversation affinity, scope-safe prepared KV leases,
  durable restore/invalidation, and verified cache telemetry. Use
  `request_priority: "realtime"` for latency-sensitive turns and
  `routing: "local_only"` when remote egress is forbidden. See
  [`docs/Designs/ConversationContextCache.md`](docs/Designs/ConversationContextCache.md).

See [`docs/features-overview.md`](docs/features-overview.md) for the full picture.

### Using Models

Via the web UI:
1. Open http://localhost:3001
2. Click "Load" on any model in the Local Models section
3. Make API requests specifying the model name

Via API:
```bash
# List available models
curl http://localhost:8080/models

# Load a model
curl -X POST http://localhost:8080/models/load \
  -H "Content-Type: application/json" \
  -d '{"model": "Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf"}'

# Chat with a model
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q5_k_m.gguf",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Directory Structure

```
llama-server/
├── api/
│   ├── server.js           # Express API (model management, downloads)
│   └── package.json
├── ui/
│   ├── src/App.jsx         # React UI
│   └── ...
├── container-start.sh      # Starts llama-server in router mode (runs in container)
├── start-llama.sh          # Wrapper that enters distrobox
├── start-preset.sh         # Starts one configured preset with literal argv
├── start-ds4.sh            # Starts the package/source DS4 engine
├── llama-manager.service   # canonical package system service
├── config.json             # Configuration (auto-generated)
├── install.sh              # Installation script
└── uninstall.sh            # Uninstallation script

~/models/                   # Your GGUF model files
├── Qwen_Qwen2.5-Coder-32B-Instruct-GGUF/
│   └── qwen2.5-coder-32b-instruct-q5_k_m.gguf
├── Unsloth_Qwen3-Coder-30B-A3B-Instruct-GGUF/
│   └── ...
└── ...
```

## API Endpoints

### Management API (port 3001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status |
| `/api/models` | GET | List local & loaded models |
| `/api/models/load` | POST | Load a model |
| `/api/models/unload` | POST | Unload a model |
| `/api/server/start` | POST | Start llama server |
| `/api/server/stop` | POST | Stop llama server |
| `/api/pull` | POST | Download model from HuggingFace |
| `/api/search` | GET | Search HuggingFace for GGUF models |
| `/api/repo/:author/:model/files` | GET | List files in a HuggingFace repo |

### Llama Server (port 8080)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/models` | GET | List models with status |
| `/models/load` | POST | Load a model |
| `/models/unload` | POST | Unload a model |
| `/v1/chat/completions` | POST | Chat completions (OpenAI-compatible) |
| `/v1/completions` | POST | Text completions |
| `/v1/chat/completions/input_tokens` | POST | Exact local chat-template input count |
| `/v1/responses/input_tokens` | POST | Exact local Responses input count |
| `/v1/context/prepare` | POST | Count or schedule cancellable KV prefill |
| `/v1/context/:id` | GET / DELETE | Inspect or invalidate an owned prepared lease |
| `/v1/context/cache` | DELETE | Delete caller-scoped memory and disk cache state |
| `/health` | GET | Health check |

### Embeddings (OpenAI-compatible)

A dedicated always-on `llama-server --embeddings` instance serves
`POST /api/v1/embeddings` (alias `POST /api/embeddings`) on the same host/port as
the dashboard — through the existing reverse proxy, e.g.
`https://llama.lair.jaxns.net/api/v1/embeddings`.

```bash
curl -s http://localhost:5250/api/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen3-Embedding-0.6B","input":["hello","world"]}'
```

Returns `{ "object":"list", "data":[{"embedding":[...]}, ...], "usage":{...} }`.
Default model **Qwen3-Embedding-0.6B → 1024-dim** vectors; batched input (array)
is returned in one response. The model is selectable in the UI (Models page) and
downloadable via the downloader. Setup is handled by `install.sh` — no extra
commands.

## Service Management

For a source-checkout installation:

```bash
# Start
systemctl --user start llama-manager

# Stop
systemctl --user stop llama-manager

# Restart
systemctl --user restart llama-manager

# Check status
systemctl --user status llama-manager

# View logs
journalctl --user -u llama-manager -f

# Enable auto-start
systemctl --user enable llama-manager

# Disable auto-start
systemctl --user disable llama-manager

# Keep running after logout (requires sudo once)
sudo loginctl enable-linger $USER
```

For a packaged installation:

```bash
llama-managerctl status
llama-managerctl restart
llama-managerctl logs -f
```

## Kiosk mode (optional)

To dedicate this machine to the dashboard (boot straight into full-screen
Chrome), see [docs/Utilities/kiosk.md](docs/Utilities/kiosk.md):

```bash
sudo bash scripts/install-kiosk.sh install     # set up + bring up now
sudo bash scripts/install-kiosk.sh restart     # re-enter without rebooting
sudo bash scripts/install-kiosk.sh uninstall   # revert
```

## Configuration

Source installs edit `config.json`; package installs default to
`/etc/llama-manager/config.json` and can use `llama-managerctl config`:

```json
{
  "autoStart": true,      // Auto-start llama server when API starts
  "modelsMax": 2,         // Max models loaded simultaneously
  "contextSize": 8192     // Default context size
}
```

Environment variables (set in systemd service or shell):
- `MODELS_DIR`: Models directory (default: `~/models`)
- `LLAMA_MANAGER_CONFIG_DIR`: Configuration directory (package default: `/etc/llama-manager`)
- `LLAMA_MANAGER_DATA_DIR`: Persistent data root (package default: `/var/lib/llama-manager`)
- `LLAMA_MANAGER_CACHE_DIR`: Cache root (package default: `/var/cache/llama-manager`)
- `DS4_GGUF_DIR`: Dedicated DS4 model directory
- `DS4_STATE_DIR`: DS4 version/build state directory
- `SLOT_SAVE_PATH`: llama.cpp slot KV-cache directory
- `API_PORT`: Management API port (default: `3001`)
- `LLAMA_PORT`: Llama server port (default: `8080`)
- `MODELS_MAX`: Max simultaneous models (default: `2`)
- `CONTEXT`: Context size (default: `8192`)

Packaged appliance installs can configure a group-writable local directory,
existing partition, or credential-free NFS export with
`scripts/configure-model-storage.sh`; see
[`docs/Utilities/model-storage.md`](docs/Utilities/model-storage.md).

## Stability & thermal protection

A resource guard protects the host from oversized models and overheating (added
after a gpt-oss-120b incident that drove RAM to 99.9% and the APU to 98–99 °C).
All knobs live under `config.guard` (sane defaults if omitted):

```json
{
  "guard": {
    "enabled": true,
    "warnC": 90,            // pause dispatching new requests at/above this temp
    "resumeC": 80,          // resume when cooled to/below this
    "criticalC": 96,        // unload the model to force a cooldown at/above this
    "memThresholdPct": 90,  // memory-watchdog trigger (system RAM %)
    "maxQueueDepth": 8,     // reject new requests when the backlog is deeper
    "headroomFrac": 0.12,   // RAM kept free by the pre-flight fit check
    "kvBytesPerToken": 262144,
    "overheadBytes": 3221225472,
    "minContext": 4096
  }
}
```

- **Thermal governor** — governs on the hotter of GPU/CPU; throttles (pauses new
  requests) above `warnC`, resumes below `resumeC`, and unloads the model above
  `criticalC`. Current state shows on the dashboard ("Thermal Guard" card) and in
  `/api/stats` (`guard`).
- **Memory** — an earlier memory watchdog (`memThresholdPct`) plus a coarse
  pre-flight that refuses a model whose weights cannot fit available RAM.
- **Queue** — bounded by `maxQueueDepth` so a stuck model can't pile up requests.

> Note: hitting 98–99 °C indicates marginal cooling for sustained max-power loads.
> The governor protects against shutdown, but also check physical cooling / the
> APU power cap if you run large models continuously.

### GPU wedge alerting (Discord / email)

On AMD Strix Halo (gfx1151) the iGPU can wedge under the older-firmware MES suspend
bug — `/dev/kfd` starts returning `EINVAL` and local models go offline until a
reboot. `scripts/gpu-wedge-alert.sh` is a standalone systemd-timer watchdog
that detects this and **pings the operator directly**, independent of llama-manager
(so it still alerts even if the manager itself is down or thrashing).

What it does, every 2 minutes:
- Detects a wedge from **`/dev/kfd` `EINVAL`** or **new fatal `amdgpu` kernel log lines**
  (`MES failed to respond`, `GPU reset`, `unrecoverable`, ring timeouts).
- On a state change (healthy→wedged, and wedged→recovered) sends a **Discord webhook**
  message and an **email**, plus a local `wall`. It is debounced — it alerts on
  transitions, not on every poll.

Setup:

```bash
# 1. Install the timer + a chmod-600 config template at /etc/gpu-wedge-alert.env
sudo ./scripts/gpu-wedge-alert.sh install

# 2. Fill in your channels (the webhook URL is a secret — keep it in this file only)
sudo nano /etc/gpu-wedge-alert.env
#   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
#   ALERT_EMAIL=you@example.com        # needs an MTA (msmtp/sendmail); Discord works without one
#   HOSTLABEL=Frostburn                # shown in the alert

# 3. Verify both channels fire
sudo ./scripts/gpu-wedge-alert.sh test
```

Create the Discord webhook under **Server Settings → Integrations → Webhooks**. Email
requires a working `mail`/`sendmail` on the host; if you don't have one, Discord alone
is fine. Check it's running with `systemctl status gpu-wedge-alert.timer`.

### GPU stability hardening & reboot recovery

`scripts/gpu-stability-setup.sh` prepares the host to run for days/weeks and to
**recover a hung reboot without a physical power cycle**. It is backed-up, supports
`--dry-run`, and never auto-reboots — firmware/cmdline changes apply on your next
reboot.

```bash
sudo ./scripts/gpu-stability-setup.sh all --dry-run   # preview everything
sudo ./scripts/gpu-stability-setup.sh all             # apply, then reboot when ready
# or run a single concern: firmware | cmdline | watchdog
```

- **`firmware`** — updates `/lib/firmware/amdgpu` to current upstream (MES `0x86`,
  which fixes the page-fault/hang class). Verify the pinned `LINUX_FIRMWARE_REF`
  carries the gfx1151 blob before relying on it.
- **`cmdline`** — adds `amdgpu.runpm=0` (workaround for the MES queue-suspend hang)
  to GRUB, and removes the deprecated `amdgpu.cwsr_enable=0` (it was a red herring
  and caused illegal-opcode faults of its own).
- **`watchdog`** — loads the AMD FCH watchdog (`sp5100_tco`) and sets
  `RebootWatchdogSec`, so a reboot that stalls on amdgpu shutdown **auto-hard-resets**
  instead of hanging until a physical power cycle. (If the current GPU is already
  wedged and a reboot stalls, force it with `echo s > /proc/sysrq-trigger; echo b > /proc/sysrq-trigger`.)

Full background and the engine build process are in
[`docs/llama-cpp-rocm-build-and-deployment.md`](docs/llama-cpp-rocm-build-and-deployment.md);
the `system-health-monitor` skill watches these signals proactively. The two
distinct gfx1151 GPU failure modes (illegal-opcode vs. MES suspend wedge), the
known-good kernel/ROCm/firmware stack, and the watchdog caveat are documented in
[`docs/strix-halo-gpu-stability.md`](docs/strix-halo-gpu-stability.md).

## Adding Models

### HuggingFace token (gated/private models)
Gated models (e.g. `google/gemma-*`) require a HuggingFace token. Set it in
**Settings → HuggingFace Token** (stored in config, preferred over the
`HF_TOKEN` environment variable; the raw value is never returned by the API).
Accept the model's license on huggingface.co as well. If a download fails for a
gated model, the UI shows an actionable message pointing here.

For unattended startup, `./install.sh` migrates the `HF_TOKEN` environment
fallback into a mode-0600 systemd `EnvironmentFile`. Runtime launchers then
copy it atomically into a mode-0600 file beneath the per-user runtime directory
and give Distrobox only that filename. The raw token is never placed in a
service definition or process command line. After rotating a token, update it
in Settings (preferred), or update the environment fallback and rerun
`./install.sh` before restarting the service.

### Via Web UI
1. Go to "Download from HuggingFace" section
2. Search for a model (e.g., "qwen coder gguf")
3. Click on a repository to see available files
4. Click "Download" on the quantization you want

### Manually
Place `.gguf` files directly in `~/models/`:
```bash
# Create a subdirectory for organization
mkdir -p ~/models/my-model
cp /path/to/model.gguf ~/models/my-model/

# Or download with huggingface-cli
huggingface-cli download Qwen/Qwen2.5-Coder-32B-Instruct-GGUF \
  --include "*Q5_K_M*.gguf" \
  --local-dir ~/models/Qwen_Qwen2.5-Coder-32B-Instruct-GGUF
```

## Troubleshooting

### Models not appearing
- Check that files end in `.gguf`
- Verify they're in `~/models` or subdirectories
- Restart the API: `systemctl --user restart llama-manager`

### Server won't start
Check logs: `journalctl --user -u llama-manager -f`

### distrobox errors
Ensure the container exists: `distrobox list`. If it is not running, initialize
it with `distrobox enter llama-rocm-7.2.4`.
For source installs, set `DISTROBOX_CONTAINER` in the user
`llama-manager.service` environment to use a different container. Debian
packages intentionally pin `llama-rocm-7.2.4`; note `.env` alone does not
override the systemd user environment; see
[`docs/llama-cpp-rocm-build-and-deployment.md`](docs/llama-cpp-rocm-build-and-deployment.md)).
To create it: `distrobox create --name llama-rocm-7.2.4 --image docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.4 --yes`

### Permission denied
```bash
chmod +x start-llama.sh container-start.sh
```

### Service stops after logout
Enable lingering: `sudo loginctl enable-linger $USER`

### Model loading fails
- Check GPU memory availability
- Try reducing `modelsMax` in config.json
- Try a smaller quantization (Q4 instead of Q5/Q6)

### Strix Halo / Ryzen AI MAX: `amdxdna` NPU driver breaks GPU compute (`/dev/kfd` EINVAL)

**Affects:** AMD Strix Halo / Ryzen AI MAX systems (gfx1151 iGPU) on any
Linux kernel that ships the in-tree `amdxdna` NPU driver. We hit this
multiple times on this hardware — it is the single biggest cause of
"tok/s collapsed and the GPU meter shows nothing" on Strix Halo.

**Symptoms**

- `llama-server` starts but logs at model-load time:
  ```
  ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device is detected
  load_tensors:          CPU model buffer size = ... MiB
  load_tensors:   CPU_REPACK model buffer size = ... MiB
  ```
  Every tensor buffer lands on CPU even though `-ngl 99` is set.
- `rocminfo` (host or inside the distrobox container) returns:
  ```
  ROCk module is loaded
  Unable to open /dev/kfd read-write: Invalid argument
  ```
- `cat /sys/class/drm/card*/device/gpu_busy_percent` stays at `0` during
  prompt processing AND generation (not "low" — literally zero).
- Token rate drops to <1 tok/s on a model that should do 10-40 tok/s on
  the iGPU. The whole inference runs on the CPU's vector units instead.
- `dmesg` typically shows lines like
  `amdxdna 0000:c7:00.1: [drm] *ERROR* amdxdna_drm_open: SVA bind device failed, ret -19`
  — that's the smoking gun.

**Cause**

On Strix Halo two drivers want the same char device. Both `amdxdna` (the
NPU compute driver) and `amdgpu`'s KFD path expose themselves through
`/dev/kfd`. If `amdxdna` loads first — or in some kernel versions, if it
loads *at all* alongside `amdgpu` — it corrupts the IOMMU/SVA state that
the KFD interface relies on. After that, ROCm's `open("/dev/kfd", O_RDWR)`
returns `EINVAL` and HIP cannot see the iGPU at all. The device node is
still there with mode `0666`, so `chmod` / render-group fiddling /
container privilege flags will *not* fix it — it is a kernel-internal
state issue, not a permissions issue.

**Fix and why it works**

Permanently blacklist `amdxdna` so it never loads, then reboot once so
`amdgpu` can initialize KFD cleanly without `amdxdna` having corrupted
the IOMMU state first.

The bundled wrapper script does the blacklist write, attempts an unload,
restarts `llama-manager`, and verifies the GPU is back:

```bash
./scripts/fix-strix-halo-npu-conflict.sh
```

Equivalent manual steps:

```bash
echo "blacklist amdxdna" | sudo tee /etc/modprobe.d/blacklist-amdxdna.conf
sudo reboot   # required the first time — see note below
```

> ⚠️ **A reboot is almost always required the first time.** Unloading
> `amdxdna` with `modprobe -r` does NOT unwind the broken KFD state
> already wedged inside `amdgpu` — the only ways to clear it are
> (1) a full host reboot (recommended; the blacklist file keeps
> `amdxdna` out so a fresh `amdgpu` initializes alone), or
> (2) a full `amdgpu` driver reload via
> [`scripts/fix-gpu-passthrough.sh`](scripts/fix-gpu-passthrough.sh),
> which is risky — it will kill any running display server and every
> GPU-using process, and must be run from a TTY with the desktop stopped.
> If `modprobe -r amdxdna` fails with `Module is in use`, something is
> still holding `/dev/accel*` open and reboot is the only safe option.

**Why the blacklist is the right fix, not a workaround**

We are not using the NPU for anything — `llama.cpp` targets the iGPU
via ROCm/HIP, not the XDNA NPU. The `amdxdna` driver provides zero
value on this stack, and its presence breaks the path we actually
depend on. Removing it permanently is strictly an improvement; there
is nothing to give up. The blacklist file persists across reboots and
kernel updates, so the fix is durable as long as that file stays in
place. Re-verify after any major distro upgrade.

**Verify after the reboot**

```bash
lsmod | grep amdxdna                                           # should be empty
python3 -c "import os; os.open('/dev/kfd', os.O_RDWR)"         # should succeed (no EINVAL)
podman exec llama-rocm-7.2.4 rocminfo | grep -E 'gfx|Marketing Name'
# Expected: gfx1151 and "AMD Radeon Graphics" (or similar)

watch -n1 'cat /sys/class/drm/card*/device/gpu_busy_percent'
# Send a chat request — busy% should rise during prompt processing/generation.
# (Note: on Strix Halo even this kernel counter often under-reports;
# look at power draw via rocm-smi or the Llama Manager dashboard for a
# more reliable "GPU is doing work" signal — see GOTCHAS for why.)
```

See [`docs/GOTCHAS.md`](docs/GOTCHAS.md) for the full archive of
Strix-Halo-specific issues we've hit (stale KFD state needing a full
`amdgpu` reload, GTT/UMA tuning, etc.) and how to report a new one.

## OpenCode Setup

Llama Manager works with [OpenCode](https://opencode.ai) as an OpenAI-compatible provider.

### Quick Setup

Paste this prompt into OpenCode to have it configure itself:

```
Configure yourself to use my local Llama Manager as a provider. Create or update opencode.json with:
- Provider ID: "llama-manager"
- Use @ai-sdk/openai-compatible
- Base URL: http://localhost:5250/api/v1
- No API key needed (local server)

Then fetch the available models from http://localhost:5250/api/v1/models and add them to the config.
Set reasonable context limits based on the model names (32k for most, 128k for models with "128k" in name).
```

### Manual Configuration

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama-manager": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Llama Manager",
      "options": {
        "baseURL": "http://localhost:5250/api/v1"
      },
      "models": {
        "your-model-id": {
          "name": "Your Model Name",
          "limit": {
            "context": 32768,
            "output": 4096
          }
        }
      }
    }
  }
}
```

Replace `your-model-id` with the actual model IDs from your loaded models. Get the list with:

```bash
curl http://localhost:5250/api/v1/models
```

## MCP Server

Llama Manager includes an MCP (Model Context Protocol) server for integration with AI agents like Claude Desktop.

### Setup with Claude Desktop

Add to your Claude Desktop config (`~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llama-manager": {
      "command": "node",
      "args": ["/path/to/llama-server/mcp/server.js"],
      "env": {
        "LLAMA_MANAGER_URL": "http://localhost:5250"
      }
    }
  }
}
```

Replace `/path/to/llama-server` with the actual path to this repository.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `llama_get_status` | Get server status, mode, and health |
| `llama_get_stats` | Get CPU, memory, GPU, and context usage |
| `llama_get_analytics` | Get time-series performance data |
| `llama_list_models` | List local and loaded models |
| `llama_load_model` | Load a model into the server |
| `llama_unload_model` | Unload a model from the server |
| `llama_start_server` | Start the llama server in router mode |
| `llama_stop_server` | Stop the llama server |
| `llama_get_settings` | Get current server settings |
| `llama_update_settings` | Update server settings |
| `llama_list_presets` | List available presets |
| `llama_activate_preset` | Activate a preset |
| `llama_search_models` | Search HuggingFace for GGUF models |
| `llama_download_model` | Download a model from HuggingFace |
| `llama_get_processes` | List running llama-server processes |
| `llama_get_logs` | Get recent server logs |
| `llama_chat` | Send a chat completion request |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLAMA_MANAGER_URL` | `http://localhost:5250` | Llama Manager API URL |

## Documentation

Additional documentation is available in the [docs/](docs/) directory:

- [Architecture Overview](docs/Designs.md) - System architecture and design decisions
- [Feature Template](docs/Designs/Feature.md) - Template for documenting new features
- [Chat Page Design](docs/Designs/ChatPage.md) - Full chat interface design
- [Docs Page Design](docs/Designs/DocsPage.md) - In-app documentation design
- [API Docs Design](docs/Designs/ApiDocs.md) - API documentation enhancements
- [OpenCode Integration](docs/Designs/OpenCode.md) - OpenCode AI setup and configuration
