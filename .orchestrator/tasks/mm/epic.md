# Multimodal API: audio, video/YouTube, agent-readable docs

## Goal
Make Llama Manager's multimodal capability (images, audio, video, YouTube) fully
usable and fully documented through the OpenAI-compatible API — not just inside
the Chat UI.

## Design document (READ FIRST)
`docs/superpowers/specs/2026-07-30-multimodal-api-design.md` — committed on `main`
as d775d74. It contains the verified current state, the content-part contract, the
module layout, and the risk list. Every subtask references sections of it.

## Context
Recon on 2026-07-30 established:
- `api/media.js` already downloads YouTube (yt-dlp) and extracts ≤16 frames @768px.
- None of it is reachable from `/v1/chat/completions` — the Chat UI orchestrates
  `/api/media/*` client-side, so API consumers cannot pass a video or YouTube link.
- Video is **silent**: frame extraction runs ffmpeg with `-an`.
- Audio is entirely absent; `sniffMediaType()` rejects all non-image/video MIME.
- Routes mount at `/api/v1`, not `/v1`, so a stock OpenAI SDK 404s.
- Both Gemma-4 mmproj files carry `clip.has_audio_encoder` AND
  `clip.has_vision_encoder`, and the engine `.so` contains `input_audio`.
  **Native audio is existing capability that is merely unplumbed.**

## Primary constraint
OpenAI API compatibility is the primary goal. Extensions are additive and
namespaced; a client that sends only standard parts must see zero behaviour change.

## Workstream
Stage A (parallel, no `api/server.js`): audio in media pipeline; API spec module; Chat UI audio.
Stage B (serialized — all touch `api/server.js`): bare `/v1` aliases + expansion;
capability metadata; transcriptions; doc routes.
Stage C: API Docs page; `/docs` update; live verification against real Gemma-4.

## Done means
- Stock OpenAI SDK at `base_url=http://<host>:5250/v1` completes a chat.
- One `chat/completions` call with a YouTube `video_url` returns an answer
  informed by both visuals and speech.
- Audio understood by Gemma-4, **verified live on the box**.
- `/llms-full.txt` documents every route actually served.
- `./scripts/dev-build.sh check` and `./scripts/dev-build.sh container` pass.
