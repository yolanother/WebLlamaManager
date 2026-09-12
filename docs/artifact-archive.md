<!--
DoubTech CI — archive file server guide.

The operator- and integrator-facing reference for the separately published
artifact download surface: why it is a second port rather than a second service,
the three ways to fetch an artifact from it (an obfuscated uuid-style direct
download for a project that opted in, a limited link minted with a project's
server-to-server API key, and a direct key-authenticated download), the
per-project settings that bound a minted link's lifetime and download budget, how
archive API keys are scoped so one cannot reach another project's artifacts or
the dashboard at all, the full HTTP contract of each route with its failure
codes, and the reverse-proxy expectations for resumable multi-gigabyte
downloads. Read this to hand an external service a download URL, to decide
whether to expose a project's artifacts, or to debug a 403 from the archive.

Copyright (c) 2026 Doubling Technologies. Use of this file is governed by the
LICENSE file in the repository root.
-->

# Archive file server

External services — installers, update channels, partner pipelines — need to
download CI artifacts. Handing them a dashboard session is wrong (it grants the
whole control plane) and exposing port 8420 is worse.

The archive file server is a **second listener in the same server process**,
sharing the database handle and artifact store but registering none of the
dashboard's routes. It carries downloads and nothing else, which is what makes it
the one port safe to publish:

| Port | Surface | Exposure |
| --- | --- | --- |
| 8420 | Dashboard, REST API, node gateway, MCP | Private interface |
| 8422 | Artifact downloads only | Public, via `CI_ARCHIVE_BASE_URL` |

It is a port split rather than a separate service because there is no state to
separate: the same rows and the same bytes back both, and a second process would
buy a second deployment for no isolation the port boundary does not already give.

## The three ways in

### 1. Direct download by artifact id (obfuscation only)

```
GET https://archive.ci.jaxns.net/d/<artifactId>/<filename>
```

An artifact id is already a random UUID, so the path itself is the uuid-style
name — **the URL being unguessable is the only protection**. This is off by
default and enabled per project (Archive downloads → *Allow direct downloads by
artifact id* on the project page, or `archivePublic` via
`PATCH /api/projects/:id`).

A project that has not opted in answers `404`, not `403`: a `403` would confirm
the id names a real artifact, which is the one thing obfuscation must not leak.

Use this for genuinely public downloads — release channels, update feeds — where
a shareable, stable URL is the point.

### 2. A minted, limited link

An external service holding an archive API key asks for a link:

```bash
curl -X POST https://archive.ci.jaxns.net/api/links \
  -H "Authorization: Bearer dtci_sk_..." \
  -H 'content-type: application/json' \
  -d '{"artifactId":"<id>","ttlSeconds":900,"maxDownloads":3}'
```

```json
{
  "url": "https://archive.ci.jaxns.net/l/<token>",
  "token": "<token>",
  "artifactId": "<id>",
  "filename": "app.zip",
  "expiresAt": "2026-08-23T18:15:00.000Z",
  "maxDownloads": 3
}
```

The returned URL needs no credential, so it can be handed to a browser, an
installer, or a customer. It is bound to exactly one artifact.

`ttlSeconds` and `maxDownloads` are **clamped to the project's ceilings** — a
caller may always ask for less than the project permits and never for more. Omit
either and the project's configured value is used. A `maxDownloads` of `0` means
unlimited within the link's lifetime.

The token carries no signature. The download counter needs persisted state
regardless, so the `archive_links` row is the authority; an HMAC would be a
second mechanism answering the same question. Spending a download is a single
conditional `UPDATE`, so a link with one download left cannot serve two
concurrent requests.

Failure codes: `404` for an unknown token, `403` for an expired or exhausted one
(the holder legitimately had that link and is better served knowing it lapsed
than by a misleading "not found").

### 3. Direct key-authenticated download

```bash
curl -fL -H "Authorization: Bearer dtci_sk_..." \
  https://archive.ci.jaxns.net/a/<artifactId> -o app.zip
```

The same credential fetching its own project's bytes without the extra round
trip. Use this for server-to-server pulls; use a minted link when the URL has to
leave your infrastructure.

## Archive API keys

Created per project (project page → Archive downloads → *Create archive key*, or
`POST /api/projects/:id/archive-keys`). The clear `dtci_sk_…` secret is shown
exactly once and only its SHA-256 hash is stored.

An archive key holds the **`archive` scope alone**, which the dashboard guard
does not admit — it accepts `read` and `*` only. So a leaked archive key can
download the artifacts of the one project it is bound to and nothing else: not
another project's artifacts (`403`), not the dashboard, not the node gateway.

Revoke from the same card, or
`DELETE /api/projects/:id/archive-keys/:keyId`. A revoked key answers `401`.

## Per-project settings

| Setting | Column | Meaning |
| --- | --- | --- |
| Allow direct downloads by artifact id | `archivePublic` | Enables `/d/:artifactId/:filename` for this project. |
| Link lifetime (seconds) | `archiveLinkTtlSeconds` | Both the default applied when a caller names no TTL and the ceiling a request is clamped to. Default `3600`. |
| Downloads per link | `archiveLinkMaxDownloads` | Both the default and the ceiling. `0` (default) is unlimited within the lifetime. |

All three are patchable on `PATCH /api/projects/:id`.

## Download cards follow the setting

When a project is archive-public, the dashboard's download cards and per-OS
controls link through the archive URL rather than the dashboard's signed
`/api/artifacts/:id/download`. The operator therefore sees exactly the URL an
external service would use, instead of a link that works only for them.

A project that is not archive-public keeps today's behavior: a pre-signed
`?exp=&sig=` URL when `CI_URL_SIGNING_SECRET` is configured, a plain path
otherwise.

## Resumable downloads

Every archive route declares `Content-Length`, advertises `Accept-Ranges: bytes`,
and honors a single `bytes=` range with a `206` and a `Content-Range` — the same
implementation the dashboard download route uses (`server/src/artifactDownload.ts`),
so an 18 GB appliance ISO resumes identically on either port. A reverse proxy in
front of 8422 must pass `Range` through and must not buffer the response; see
[Deployment → Publishing the archive port](deployment.md#publishing-the-archive-port).

### Validating a resume

Responses carry a strong `ETag` — the artifact's stored sha256 — and honor
`If-Range`. A client that resumes with the validator it holds gets its `206`; a
client whose validator no longer matches (the artifact was rebuilt under it) gets
a `200` with the whole representation instead of a range spliced onto different
bytes. That fallback is what keeps a resumed multi-gigabyte download from
producing a file that is corrupt but still the expected length. A duplicated
`If-Range` header names no single validator and takes the same conservative path.

### Serving from network storage

The artifact store is typically a network mount (in this deployment,
`nas.lair.jaxns.net:/volume1/Frostburn`). Reads are buffered in chunks sized to
the artifact and capped at 4 MiB rather than Node's 64 KiB stream default — at
64 KiB an 18 GB artifact costs roughly 280,000 reads, each one a round trip that
can stall or fail.

A read that fails partway through is logged with the artifact path, the error
code, and the bytes sent before it died. This matters because the response
headers are already on the wire by then: there is no status left to answer with,
so the transfer reaches the client as a bare connection reset. The log line is
the only record that it happened, which is why the archive app attaches a request
logger even though the dashboard app does not.

## The root is a dead end

`GET /` — and every other unmatched path — answers a styled HTML **404** with an
abstract background and nothing else: no product name, no company, no framework,
no route path, no JSON. The archive is the one host facing the internet, so its
root is the most-probed path we own, and Fastify's default
`{"message":"Route GET:/ not found","error":"Not Found","statusCode":404}` would
announce both that there is a JSON API here and what serves it.

The browser-facing misses render the **same page, byte for byte**: an artifact
whose project has not opted in, an artifact id that does not exist, and a link
token that does not exist are all indistinguishable from a path with no route.
The credentialed routes (`/a/:artifactId`, `POST /api/links`) keep their JSON
errors — only a client holding a key reaches them, and it needs a parseable body.

The background is inlined as a `data:` URI, so the page is one self-contained
response: a linked asset would need a second route that is itself a probe target,
and a missing one would leave a broken page.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CI_ARCHIVE_PORT` | `8422` | Port the archive listens on. Must differ from `CI_PORT`; the server refuses to start otherwise. It is 8422 rather than the adjacent 8421 because the node-agent's local status API (`CI_AGENT_LOCAL_PORT`) already holds 8421 on a host that also runs the server. |
| `CI_ARCHIVE_BASE_URL` | `https://archive.ci.jaxns.net` | Public base URL. Minted link URLs and archive download cards are rendered against it, so it must match what the proxy publishes. |

The archive binds **before** the dashboard port so that a port it cannot bind
fails the process before `/healthz` can answer — otherwise a deploy could cut
over to a container that passes its health gate and then dies.
