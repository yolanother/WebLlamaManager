<!--
Copyright (c) Llama Manager contributors.
Use of this source code is governed by the LICENSE file in the repository root.

Public contract and operator reference for Llama Manager's OpenAI-compatible
multimodal API. This document defines accepted chat content parts, server-side
media expansion, capability discovery, processing limits, digest reporting,
outbound URL security, audio transcription, and the machine-readable API
documentation endpoints.
-->

# Multimodal API

Llama Manager accepts images, audio, direct video URLs, and YouTube URLs through
its OpenAI-compatible chat completion API. Standard OpenAI parts pass through
unchanged; Llama Manager's URL extensions are ingested and expanded into
standard parts before inference.

## Base URLs

Use the bare `/v1` base URL with stock OpenAI clients:

```text
http://localhost:5250/v1
```

The manager-prefixed routes remain available for existing clients:

```text
http://localhost:5250/api/v1
```

For example, both `POST /v1/chat/completions` and
`POST /api/v1/chat/completions` invoke the same handler. Management and the
lower-level media routes remain under `/api`.

## Chat content parts

Message `content` may be a string or an ordered array containing these parts:

| Part | Compatibility | Contract |
|---|---|---|
| `text` | OpenAI standard | `{ "type": "text", "text": "..." }` |
| `image_url` | OpenAI standard | `{ "type": "image_url", "image_url": { "url": "https://..." } }`; `data:image/...` URLs are also accepted. |
| `input_audio` | OpenAI standard | `{ "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } }`; `format` is `wav` or `mp3`. |
| `video_url` | Llama Manager extension | `{ "type": "video_url", "video_url": { "url": "https://...", "max_frames": 16, "include_audio": true, "start": 0, "end": 600 } }` |
| `audio_url` | Llama Manager extension | `{ "type": "audio_url", "audio_url": { "url": "https://..." } }` |

`video_url` options are optional except for `url`. `start` and `end` are seconds,
`max_frames` is between 1 and 16, and `include_audio` defaults to `true`. Audio
content requires a target model whose advertised modalities include `audio`.

### Images

Send an HTTPS image or an inline data URL as an `image_url` part:

```json
{
  "model": "google_gemma-4-12B-it-qat-q4_0-gguf",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image." },
      { "type": "image_url", "image_url": { "url": "https://example.com/cat.jpg" } }
    ]
  }]
}
```

### Inline audio

Inline WAV and MP3 data uses the OpenAI `input_audio` shape and is passed to the
model without URL expansion:

```json
{
  "model": "google_gemma-4-12B-it-qat-q4_0-gguf",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What is said in this recording?" },
      { "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } }
    ]
  }]
}
```

### Direct video and YouTube

A YouTube URL is a `video_url`; there is no separate YouTube part type. The same
single chat completion call downloads the media, extracts frames and audio, and
sends the expanded content to the selected model:

```json
{
  "model": "google_gemma-4-12B-it-qat-q4_0-gguf",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Summarize the visuals and speech." },
      {
        "type": "video_url",
        "video_url": {
          "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "include_audio": true,
          "max_frames": 16
        }
      }
    ]
  }]
}
```

For media within one processing window, the server expands a video into a
`[video: name, duration MM:SS]` marker, timestamped
`[frame n/N @ MM:SS]` markers followed by `image_url` frame parts, and one or
more normalized WAV `input_audio` parts when audio is requested and present.
`audio_url` similarly becomes normalized WAV `input_audio` parts.

### Outbound URL security

Direct media ingestion accepts only HTTP(S) destinations whose literal address
or every current DNS answer is publicly routable. Loopback, private, carrier
NAT, link-local (including cloud metadata), reserved, multicast, and IPv6
unique-local destinations are rejected before any request is sent. Redirects
are handled manually, limited to five hops, and resolved and validated again
before each hop. Network failures expose only a generic API error, never an
upstream response body or internal exception detail.

The YouTube route remains restricted to the supported `youtube.com` and
`youtu.be` hostname forms and validates that hostname's DNS answers before
starting `yt-dlp`.

## Limits and long-media digests

- The default processing window is 600 seconds.
- Each window uses at most 16 frames. Extracted frames have a longest edge of
  768 pixels.
- YouTube downloads are capped at 720p.
- The HTTP JSON body cap is 200 MB, including inline base64 data.
- The transcription upload follows the same 200 MB file policy, with bounded
  multipart overhead.

Media longer than one window is not silently truncated. The manager issues
bounded per-window digest completions, combines their timestamped summaries,
and retains representative frames across the requested range.

Non-streaming chat responses report expansion under
`metadata.llama_manager_media`. Streaming responses carry the same JSON object
in the `x-llama-manager-media` response header:

```json
{
  "items": [{
    "id": "media-id",
    "kind": "video",
    "durationSec": 1234.5,
    "windows": 3,
    "framesUsed": 16,
    "digested": true
  }]
}
```

`digested: true` means the source crossed the processing-window boundary and
was summarized through the map-reduce path. Expansion warnings, when present,
appear in the same object under `warnings`.

## Discover model capabilities

`GET /v1/models` and `GET /api/v1/models` add a `modalities` array to each model
record. Choose a model that advertises every input type required by the request:

```json
{
  "id": "google_gemma-4-12B-it-qat-q4_0-gguf",
  "modalities": ["text", "image", "audio"],
  "capabilitySource": "mmproj"
}
```

The manager derives `image` and `audio` support from the companion mmproj GGUF
metadata and caches the result. Operator routing overrides remain available,
and the legacy model-name vision heuristic is used only when projector metadata
is absent. There is no heuristic fallback for audio.

## Audio transcription

`POST /v1/audio/transcriptions` and
`POST /api/v1/audio/transcriptions` accept multipart form data:

| Field | Required | Description |
|---|---:|---|
| `file` | yes | Uploaded audio file. |
| `model` | yes | Local model whose modalities include `audio`. |
| `response_format` | no | `json` (default), `text`, or `verbose_json`. |
| `language` | no | Language hint forwarded in the transcription prompt. |
| `prompt` | no | Vocabulary or context hint. |

```bash
curl -sS http://localhost:5250/v1/audio/transcriptions \
  -F 'file=@/path/to/audio.wav' \
  -F 'model=google_gemma-4-12B-it-qat-q4_0-gguf' \
  -F 'response_format=verbose_json'
```

Uploads are normalized to 16 kHz mono WAV and processed in fixed windows.
`verbose_json` segment `start` and `end` values are approximate window edges,
not detected speech boundaries or word-level timestamps. Gemma is a general
multimodal model, not a dedicated ASR model.

## Stock OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:5250/v1", api_key="local")
response = client.chat.completions.create(
    model="google_gemma-4-12B-it-qat-q4_0-gguf",
    messages=[{"role": "user", "content": "Reply with one short sentence."}],
)
print(response.choices[0].message.content)
```

The local service does not require an API key, but the stock SDK requires a
non-empty value. Treat the value above as a client placeholder, not a service
credential.

## Lower-level media API

Clients that need explicit ingestion and artifact control may use the existing
`/api/media` routes: upload or link a source, inspect its metadata, and fetch the
stored file, extracted frames, or normalized audio segments. Chat clients should
normally prefer `video_url` or `audio_url`, which perform this work in one
completion call.

## API documentation URLs

- `/llms.txt` — concise agent-readable Markdown index.
- `/llms-full.txt` — complete agent-readable Markdown reference with schemas
  and curl, Python, and JavaScript examples.
- `/api/llms.txt` and `/api/llms-full.txt` — manager-prefixed aliases.
- `/api/openapi.json` — generated OpenAPI document.
- `/api/info` — discovery links for the OpenAPI and agent-readable documents.

These documents and the API Docs UI are generated from the shared endpoint
catalog in `api/api-spec.js` so their route inventory and examples stay aligned.
