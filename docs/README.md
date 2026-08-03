# Llama Manager — Documentation

Start here. This folder documents how Llama Manager works, how to run it, and the
hardware-specific gotchas of the AMD Strix Halo (gfx1151) box it targets.

## Start here

| Doc | What it covers |
|---|---|
| [**features-overview.md**](features-overview.md) | The complete feature map — engines, routing/offload, aliasing, presets, guards, embeddings, monitoring. **Read this first.** |
| [**ds4-engine.md**](ds4-engine.md) | The DeepSeek V4 Flash (DS4) engine — exclusive mode, adaptive context + SSD-streaming, how it fits an 80&nbsp;GB model onto the box. |
| [`../README.md`](../README.md) | Project README — install, quick start, requirements, service management, troubleshooting. |

## Engines & models

- [ds4-engine.md](ds4-engine.md) — DeepSeek V4 Flash engine (overview + operation)
- [ds4-build.md](ds4-build.md) — building the ds4 binaries for gfx1151 (build vs run container, `-fPIC`)
- [ds4-auto-update.md](ds4-auto-update.md) — the ds4 self-updater (out-of-place rebuild → smoke → atomic swap)
- [llama-cpp-rocm-build-and-deployment.md](llama-cpp-rocm-build-and-deployment.md) — building/deploying the llama.cpp engine on ROCm
- [Designs/EngineAbstraction.md](Designs/EngineAbstraction.md) — the two-engine seam, exclusive mode, adaptive plan (design)
- [Designs/ModelManagement.md](Designs/ModelManagement.md) — model lifecycle, presets, download

## Stability & hardware (Strix Halo)

- [strix-halo-gpu-stability.md](strix-halo-gpu-stability.md) — GPU wedge, thermal, memory hardening + reboot recovery
- [GOTCHAS.md](GOTCHAS.md) — accumulated hardware/software gotchas and workarounds

## Features & design

- [Designs.md](Designs.md) — architecture overview + design-doc index
- [features/model-alias-groups.md](features/model-alias-groups.md) — `config.aliases`: one name → an ordered list of local/remote targets, the warm gate, migration from `modelMapping`
- [features/multimodal-api.md](features/multimodal-api.md) — OpenAI-compatible image, audio, video/YouTube, long-media digest, transcription, capability-discovery, and agent-readable documentation contracts
- [features/glass-ui-and-multimodal-chat.md](features/glass-ui-and-multimodal-chat.md) — glass UI and the shared UI/API multimodal media pipeline
- [Designs/ChatPage.md](Designs/ChatPage.md) · [Designs/ApiDocs.md](Designs/ApiDocs.md) · [Designs/DocsPage.md](Designs/DocsPage.md) — UI page designs
- [Designs/OpenCode.md](Designs/OpenCode.md) — OpenCode provider integration
- [Designs/ConversationContextCache.md](Designs/ConversationContextCache.md) — exact input counts, stable conversation affinity, KV preparation, lifecycle, and cache telemetry
- [Utilities/kiosk.md](Utilities/kiosk.md) — kiosk / wall-display mode
- [Utilities/llama-manager-recovery.md](Utilities/llama-manager-recovery.md) — portable, sanitized host backup and replacement-system restore

## The mental model in one diagram

```
client (OpenAI-compatible) ── /api/v1/* on :5250
        │
        ├─ resolve alias group (config.aliases) → warm candidates, else cold
        │
        └─ route:
             ├─ local llama.cpp   (router: many models · or single preset)   :5251
             ├─ local DS4         (DeepSeek V4 Flash, exclusive)              :5253
             ├─ local embeddings  (dedicated server)                          :5252
             └─ remote backend    (Ollama, … — offload when busy/hot/DS4)
   guarded throughout by: memory watchdog · thermal governor · restart governor ·
                          queue admission · protect-resident · slot reaper
```

## Keeping docs current

Docs are treated as code. After editing anything under `/docs`, run:

```bash
orch docs sync
```

Document every new feature, record important decisions, and keep these files in sync
with the code (headers in `api/*.js` also carry per-module purpose docs).
