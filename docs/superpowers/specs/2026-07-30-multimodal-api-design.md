# Multimodal API: audio, video/YouTube, docs, and agent-readable reference

**Date:** 2026-07-30
**Status:** Approved design — ready for implementation
**Epic:** see `orch tasks list --parent <epic>`

---

## 1. Why

Llama Manager already has a real server-side media pipeline, but none of it is
reachable from the OpenAI-compatible API, video is silent, and audio is entirely
absent. The API documentation describes 4 endpoints out of ~70 and says nothing
about multimodal usage. Agents cannot discover or use what the box can actually do.

The primary goal is and remains **OpenAI API compatibility**. Extensions are
additive, namespaced, and degrade gracefully.

## 2. Verified current state

Confirmed by direct inspection on 2026-07-30. Do not re-litigate these.

| Fact | Evidence |
|---|---|
| All OpenAI routes mount at **`/api/v1/...`**, never bare `/v1` | `api/server.js:7657`, `8594`, `8895`, `8959`, `9208` |
| No rewrite middleware; bare `/v1` POST falls to SPA catch-all (GET-only) → 404 | `api/server.js:9512` |
| Media pipeline exists and works | `api/media.js` (863 lines), mounted `api/server.js:226` |
| YouTube download already implemented via yt-dlp, capped 720p | `api/media.js:665-673` |
| Video → ≤16 evenly spaced JPEG frames, longest edge 768px | `api/media.js:33`, `:114`, `:552` |
| **Frame extraction passes `-an` — audio is discarded** | `api/media.js:552` |
| **`sniffMediaType()` hard-rejects any non-image/video MIME** | `api/media.js:257`, `:298` |
| Chat proxy is pass-through; only sampling/reasoning injected | `api/server.js:7719` |
| Body cap 200 MB (what makes base64 work) | `api/server.js:114` |
| Vision capability is a **regex on model id**, not real metadata | `api/chat-router.js:17` |
| `estimateInputTokens` counts only text parts — images cost 0 | `api/server.js:671-679` |
| `api/openapi.json` stale (Feb 19), missing `/api/media/*`, `/api/backends/*`, etc. | `api/openapi.json` |
| No auth middleware on any route | verified repo-wide |
| Chat UI does images/video/YouTube by calling `/api/media/*` then base64-ing frames **client-side** | `ui/src/pages/Chat.jsx:234-287`, `ui/src/components/chat/attachments.js:85-140` |
| API Docs page = hardcoded JS arrays, 4 OpenAI endpoints, raw `<pre>`, no highlighting | `ui/src/pages/ApiDocs.jsx:253-320` |
| No `llms.txt` / markdown doc route anywhere | verified repo-wide |

**Decisive capability finding:** both Gemma-4 mmproj files carry
`clip.has_audio_encoder` **and** `clip.has_vision_encoder`:

- `/home/yolan/models/google_gemma-4-12B-it-qat-q4_0-gguf/mmproj-gemma-4-12b-it-qat-q4_0.gguf`
- `/home/yolan/models/google_gemma-4-E2B-it-qat-q4_0-gguf/gemma-4-E2B-it-mmproj-F16.gguf`

and the engine's `libllama-server-impl.so` contains `input_audio` plus full
`mtmd_*` bindings. **Native audio is existing capability that is simply not
plumbed.** `yt-dlp` 2026.07.04 and a static `ffmpeg`/`ffprobe` are installed at
`~/.local/bin` (note: user-local — the systemd unit needs that on `PATH`).

## 3. Operator decisions

1. Full build-out: docs **and** native audio, sound-aware video, capability metadata.
2. Server-side expansion of media URLs in `chat/completions`, **and** keep `/api/media` documented as the lower-level path.
3. Add bare `/v1/*` aliases for stock OpenAI SDK compatibility.
4. Ship `/llms.txt` + full markdown **and** regenerate `openapi.json`, from one shared source.
5. Multimodal support in **both** the `/chat` page and the API Docs live tester.
6. Long media is **segmented and summarized**, not truncated or rejected.
7. Add `/v1/audio/transcriptions`.
8. Verify live against a real Gemma-4 load (DS4 stays resident).

## 4. Content-part contract

### Standard (OpenAI — must keep working unchanged)

```jsonc
{ "type": "text",  "text": "..." }
{ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
{ "type": "image_url", "image_url": { "url": "https://example.com/cat.jpg" } }
{ "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } }
```

`input_audio` is OpenAI-standard and natively understood by llama.cpp — it is
passed through untouched. `format` accepts `wav` and `mp3`.

### Extensions (additive, namespaced by part type)

```jsonc
{ "type": "video_url", "video_url": {
    "url": "https://www.youtube.com/watch?v=...",
    "max_frames": 16,          // optional, default from config
    "include_audio": true,     // optional, default true
    "start": 0, "end": 600     // optional seconds
} }
{ "type": "audio_url", "audio_url": { "url": "https://example.com/talk.mp3" } }
```

A YouTube link is simply a `video_url` whose host matches the existing
`classifyMediaUrl()` YouTube set (`api/media.js:66`). There is no separate
YouTube part type.

**Expansion is server-side and transparent.** Before proxying upstream, a
`video_url` becomes: one `text` marker (`[video: <name>, duration MM:SS]`), N
`image_url` parts each preceded by a `[frame n/N @ MM:SS]` marker (preserving the
convention already documented in `docs/features/glass-ui-and-multimodal-chat.md`),
and — when `include_audio` and the target model has an audio encoder — one or more
`input_audio` parts. Clients that never send extension parts see zero behaviour change.

## 5. Architecture

New modules keep `api/server.js` edits to thin mount lines. `server.js` is already
10k lines; do not grow it with logic.

```
api/media.js              (extend)  audio sniffing, ffmpeg audio extraction, audio routes
api/media-segments.js     (new)     window planner + map-reduce digest for long media
api/multimodal-expand.js  (new)     content-part walker: video_url/audio_url -> standard parts
api/model-capabilities.js (new)     parse mmproj GGUF KV -> {vision, audio} per model
api/audio-transcriptions.js (new)   OpenAI /v1/audio/transcriptions
api/api-spec.js           (new)     single source of truth for every endpoint + examples
```

### 5.1 Audio in the media pipeline

- Widen `sniffMediaType()` with magic-byte detection for `wav` (RIFF/WAVE),
  `mp3` (ID3 / 0xFFFB), `flac` (fLaC), `ogg` (OggS), `m4a` (ftyp…M4A).
- `extractAudio()`: `ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le` → 16 kHz mono WAV.
  This is what the Gemma audio tower expects.
- **Video keeps its existing silent frame path** (`-an` stays on the frame
  command — do not change it). Audio is a *separate* ffmpeg invocation on the
  same source file.
- New routes: `GET /api/media/:id/audio/:n.wav`; `GET /api/media/:id` metadata
  gains `audio: { segments, durationSec, sampleRate, channels }`.
- Preserve the existing dependency injection (`spawnImpl`, `fetchImpl`,
  `idFactory`) so tests still run on hosts without ffmpeg.

### 5.2 Long media: segment and summarize

Config: window default **600 s**, ≤16 frames per window, overridable via
`LLAMA_MANAGER_MEDIA_WINDOW_SEC` / `LLAMA_MANAGER_MEDIA_MAX_FRAMES`.

- Media within one window → expanded inline. No digest, no extra model calls.
- Media longer than one window → map-reduce:
  1. Plan N windows via `planSegments(durationSec, opts)`.
  2. For each window, issue an **internal** chat completion against the same
     model with that window's frames + audio and a fixed digest prompt
     (describe speech, visuals, events, with timestamps).
  3. Replace the original part with a `[media digest: <name>]` text part carrying
     the concatenated per-window descriptions, plus a reduced set of
     representative frames spanning the whole duration.
- The response reports what happened in `metadata.llama_manager_media`:
  `{ items: [{ id, kind, durationSec, windows, framesUsed, digested: true|false }] }`.
  Never silently drop content.

### 5.3 Capability metadata

- `api/model-capabilities.js` locates `mmproj*.gguf` beside each model and parses
  the GGUF header KV for `clip.has_vision_encoder` / `clip.has_audio_encoder`.
  Cache results; the scan must not run per-request.
- `GET /v1/models` entries gain `modalities: ["text","image","audio"]`.
- `api/chat-router.js` keeps `VISION_MODEL_PATTERN` as a fallback only; real
  metadata wins. Add audio filtering alongside the existing image filtering in
  `filterRoutingCandidates()` (`chat-router.js:151`) and extend
  `attachmentPresence()` (`:102`) to recognise `input_audio` / `audio_url`.
- Add `config.routerAudioModels` as the operator override, mirroring the existing
  `config.routerVisionModels`.
- Fix `estimateInputTokens` (`api/server.js:671-679`) to charge a non-zero
  estimate for image and audio parts so queue admission and offload sizing stop
  treating multimodal requests as free.

### 5.4 Bare `/v1` aliases

Mount the identical handlers at `/v1/*` in addition to `/api/v1/*`. **Must be
registered before the SPA catch-all at `api/server.js:9512`.** Extract the
handlers to named functions and register both paths — do not duplicate logic and
do not use a redirect (it breaks POST bodies and streaming).

### 5.5 `/v1/audio/transcriptions`

Multipart `file`, `model`, `response_format` (`json` | `text` | `verbose_json`),
optional `language`, `prompt`. Reuses audio extraction + segmentation, then calls
the model with `input_audio`. `verbose_json` segment boundaries come from our own
windowing and are therefore **approximate** — document that plainly; Gemma is not
a dedicated ASR model.

### 5.6 Single source of truth for docs

`api/api-spec.js` exports one `ENDPOINTS` array: `{ method, path, summary,
description, tags, params, requestSchema, responseSchema, examples[] }` where each
example carries `curl`, `python`, and `javascript` variants.

Three consumers, zero drift:
- `GET /llms.txt` — short index (title, base URL, capability summary, endpoint list, link to full).
- `GET /llms-full.txt` — complete agent-readable markdown: every endpoint, the full
  multimodal content-part contract, worked examples including YouTube, and the
  documented limits. Served `text/markdown; charset=utf-8`.
- `api/openapi.json` — regenerated by a build script from the same array.

Also alias `/api/llms.txt` and `/api/llms-full.txt`. All doc routes must register
**before** `server.js:9512`.

### 5.7 Frontend

**API Docs page** (`ui/src/pages/ApiDocs.jsx`): render endpoints from the shared
spec instead of the hardcoded arrays. Add a Multimodal guide section covering
images, audio, video, and YouTube. Add curl/python/javascript tabs. Replace the
raw `<pre className="curl-code">` with the existing highlight.js
`ui/src/components/CodeBlock.jsx`. Prefill runnable multimodal example bodies into
the existing "Send Request" tester so examples are executable, not just copyable.
Surface links to `/llms.txt` and `/api/openapi.json`.

**Chat page**: add audio to the attach menu (`accept="audio/*"`), an audio
`AttachmentChip` variant showing duration, and `input_audio` part construction in
`ui/src/components/chat/attachments.js`. Mic recording is **out of scope**.

## 6. Risks

- **mmproj in `--models-dir` router mode may not load the audio encoder.**
  `docs/llama-cpp-rocm-build-and-deployment.md:133-152` states `--models-dir`
  cannot express per-model options and mmproj only works via router
  auto-detection. If audio fails live, fall back to `--models-preset` with
  `LLAMA_ARG_MMPROJ` (`api/server.js:4846-4867`, `container-start.sh:104-105`).
  This is the single largest unknown and is why live verification is mandatory.
- `conversationPrefixKey()` (`api/server.js:~443`) sha1s `JSON.stringify` of the
  whole prefix including megabytes of base64. Adding audio makes this worse.
  Measure; hash a digest of media parts rather than their bytes if it hurts.
- 200 MB body cap bounds inline base64; prefer `/api/media` + URL parts for large media.
- **No auth exists on any route.** Adding bare `/v1` widens the unauthenticated
  surface. Out of scope here, but flagged for the operator.
- `~/.local/bin` must be on the service `PATH` for yt-dlp/ffmpeg.

## 7. Out of scope

Mic recording in the browser; `/v1/audio/speech` (TTS); image generation;
authentication; changing the existing silent-frame behaviour of the Chat UI's
current video path beyond adding audio.

## 8. Acceptance

- A stock OpenAI SDK with `base_url=http://<host>:5250/v1` completes a text chat.
- A single `chat/completions` call containing a YouTube `video_url` returns an
  answer informed by both visuals and speech.
- An audio file sent as `input_audio` is understood by Gemma-4 **verified live**.
- `/llms-full.txt` documents every route the server actually serves.
- `./scripts/dev-build.sh check` and `container` pass.
