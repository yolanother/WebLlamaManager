# Glass UI Overhaul & First-Class Multimodal Chat

**Status:** Shipped 2026-07-24 (epic `lr8_ZBsdcK0AH4eWdthmU`, PRs #15–#22 on `feat/glass-ui-overhaul`); expanded 2026-07-30 with audio and server-side multimodal API ingestion.

## Design system (skeuomorphic glass)

- Tokens + primitives live in `ui/src/theme/glass.css`: `--glass-*` surface/border/highlight/blur vars, `--shadow-raised/floating/pressed`, `--radius-*`, `--glass-sheen`, and reusable `.glass-panel`, `.glass-panel--floating`, `.glass-btn`, `.glass-input`, `.glass-chip` classes.
- Dark is the default scheme; light mode overrides live under `[data-theme="light"]` (including light values for the legacy `--bg-*`/`--text-*` vars). Fallbacks: `@supports not (backdrop-filter)` → opaque surfaces; `prefers-reduced-motion` and `prefers-reduced-transparency` honored.
- Color scheme control: `ui/src/theme/colorScheme.js` (pure, tested) + `getColorScheme()`/`setColorScheme('dark'|'light'|'system')` in `ui/src/theme/siteTheme.js`; persisted in `localStorage['colorScheme']`; `system` follows the OS via `matchMedia`. User control: **Settings → Appearance** (segmented Dark/Light/System + site-theme picker).
- Site themes (from the private `site/` submodule) still override `:root` vars at runtime and retint the ambient background, panels, and chart colors.

## Layout / navigation

- `ui/src/App.jsx` was mechanically split (PR #17) into `ui/src/pages/*.jsx` and `ui/src/components/*.jsx`; App.jsx is now an 87-line layout+routes shell. `API_BASE` and shared fetch helpers live in `ui/src/api.js`.
- Dashboard remains the default `/` route, restyled as a glass bento grid with floating `StatsHeader` and `QueryPanel` (PR #19). Charts consume CSS vars (`--accent`, `--success`, `--warning`, `--error`, `--info`, `--chart-grid`).
- Sidebar (PR #21): SVG icon set in `ui/src/components/icons.jsx` (no emoji); **Settings moved to the sidebar footer slot** (gear); **llama.cpp UI is now a regular nav item** (external link, `stats.llamaUiUrl` or `:llamaPort` fallback) in Settings' old position.

## Chat (first-class, multimodal)

`ui/src/pages/Chat.jsx` + `ui/src/components/chat/` (PR #22):

- Two-pane layout: date-grouped conversation rail (rename/delete/import/export JSON) + centered 768px message column. User messages are right-aligned chips; assistant messages are full-width sanitized Markdown (hand-rolled allowlisted element renderer — no raw HTML injection) with copyable code blocks.
- Composer: auto-growing textarea (Enter send / Shift+Enter newline), "+" attach menu (image, audio, video file, video/YouTube link), smart paste (media URLs → attachment chips; >8k-char pastes → text attachment), drag-and-drop, in-composer model picker defaulting to **Auto (small-brain router)**. Audio attachments show their duration and are encoded as OpenAI `input_audio` parts.
- Streaming: SSE with Stop→Regenerate, scroll-lock with "Jump to latest", `aria-live="polite"`, routed-model badge from the `x-llama-router-choice` response header.
- Video attachments can use the media API directly or the server-side `video_url` chat extension. Each video becomes a `[video: name, duration]` marker plus per-frame `[frame n/N @ MM:SS]` text markers followed by `image_url` frame parts and, when requested and available, normalized `input_audio` parts. This enables timestamp-referenced Q&A informed by both visuals and sound.

## Server: media pipeline (`api/media.js`, PR #16)

Mounted at `/api/media` (2-line hook in `server.js`, storage under the runtime data dir), this is now the common lower-level ingestion pipeline for both the UI and external API clients:

- `POST /api/media/upload` (multipart), `POST /api/media/link` `{url}`, `POST /api/media/youtube` `{url}` (yt-dlp, ≤720p mp4) → media metadata containing frames, duration, and normalized audio segments when present. Outbound URL ingestion rejects non-public literal or DNS-resolved addresses, revalidates every bounded redirect hop, and returns generic network failures without upstream body details.
- `GET /api/media/:id`, `/:id/file`, `/:id/frames/:n.jpg`, and `/:id/audio/:n.wav`. Safe-id validation, bounded process runner (ffmpeg 5 min / yt-dlp 10 min timeouts), ≤16 frames per 600-second window scaled to a 768px longest edge, LRU pruning (20 items), graceful `501` with hint when yt-dlp/ffmpeg are absent. Audio is extracted separately as 16 kHz mono WAV; the frame command remains intentionally silent.
- `POST /v1/chat/completions` and `/api/v1/chat/completions` expand `video_url` and `audio_url` parts through this pipeline. Sources longer than one window use timestamped map-reduce digests and report `metadata.llama_manager_media` (`x-llama-manager-media` for streams). See [multimodal-api.md](multimodal-api.md) for the public contract.

## Server: small-brain auto routing (`api/chat-router.js`, PR #18)

- `POST /v1/chat/completions` or `/api/v1/chat/completions` with `model: "auto"` (or `default-router`): the configured `default-small` model classifies the request against the live model catalog and rewrites `body.model`; existing alias resolution and auto-switch/queue-during-swap machinery then applies. Image/audio filtering uses mmproj-derived `modalities` from `/v1/models`, with `config.routerVisionModels` / `config.routerAudioModels` operator overrides; the legacy `VISION_MODEL_PATTERN` is only a no-projector fallback. Fallback to `default-big`/`default-small` on any router failure (10s timeout). Response header `x-llama-router-choice` names the routed model.
- Base chat system prompt (`BASE_CHAT_PROMPT`) is injected ONLY for requests carrying `metadata: { llama_manager_chat: true }` or header `x-llama-manager-chat: 1` and no existing system message; it documents the image/video/YouTube skills and MM:SS timestamp convention. External OpenAI-compatible traffic is untouched.

## Deploy

`./install.sh` (vite build + systemd user service restart). `main` is the dev server; the epic is merged to local `main` and deployed. See `.claude/skills/deploy-llama-manager`.
