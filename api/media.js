// Llama Manager — server-side media ingestion, storage, and video frame extraction.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module owns the /api/media router. It accepts bounded multipart uploads,
// direct HTTP(S) media downloads, and supported YouTube URLs, then stores each
// item below the runtime data directory and prepares JPEG frames for vision
// models with ffprobe/ffmpeg. Process and network dependencies are injectable so
// the pipeline remains testable on hosts where the optional binaries are absent.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const YTDLP_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_OUTPUT_LIMIT = 16_384;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const SCALE_FILTER = "scale=w='if(gte(iw,ih),min(iw,768),-2)':h='if(lt(iw,ih),min(ih,768),-2)'";
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const require = createRequire(import.meta.url);

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
  ['video/x-matroska', 'mkv'],
  ['video/x-msvideo', 'avi'],
  ['video/ogg', 'ogv'],
  ['video/mpeg', 'mpeg'],
]);

class MediaPipelineError extends Error {
  constructor(status, body, cause) {
    super(typeof body?.error === 'string' ? body.error : 'Media pipeline failed', { cause });
    this.name = 'MediaPipelineError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Classify a candidate ingestion URL.
 *
 * @param {unknown} value Candidate URL.
 * @returns {{kind:'direct'|'youtube'|'invalid', url?:string, reason?:string}} Classification result.
 */
export function classifyMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { kind: 'invalid', reason: 'url must be a non-empty string' };
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { kind: 'invalid', reason: 'url must be a valid HTTP(S) URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'url must use http or https' };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const youtubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
  const isWatch = youtubeHost
    && parsed.pathname.replace(/\/+$/, '') === '/watch'
    && Boolean(parsed.searchParams.get('v'));
  const isShort = youtubeHost && pathParts[0] === 'shorts' && Boolean(pathParts[1]);
  const isShortLink = host === 'youtu.be' && Boolean(pathParts[0]);

  return {
    kind: isWatch || isShort || isShortLink ? 'youtube' : 'direct',
    url: parsed.href,
  };
}

/**
 * Check whether an externally supplied media id is safe as one path segment.
 *
 * @param {unknown} id Candidate id.
 * @returns {boolean} True only for the public media-id alphabet.
 */
export function isSafeMediaId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

/**
 * Select up to maxFrames evenly spaced timestamps, excluding exact endpoints.
 * Short clips use approximately one frame per second to avoid duplicate frames.
 *
 * @param {number} durationSec Media duration in seconds.
 * @param {number} [maxFrames=16] Maximum number of frames.
 * @returns {number[]} Monotonically increasing timestamps in seconds.
 */
export function frameTimestamps(durationSec, maxFrames = 16) {
  const duration = Number(durationSec);
  const cap = Math.max(0, Math.floor(Number(maxFrames)));
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(cap) || cap === 0) return [];
  const count = Math.min(cap, Math.max(1, Math.ceil(duration)));
  return Array.from({ length: count }, (_, index) => ((index + 1) * duration) / (count + 1));
}

/**
 * Run a child process without a shell, bounding captured output and execution time.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Argument vector.
 * @param {{spawnImpl?:Function, timeoutMs?:number, cwd?:string}} [options] Process options.
 * @returns {Promise<{stdout:string, stderr:string}>} Captured output on exit code zero.
 */
export function runProcess(command, args, {
  spawnImpl = nodeSpawn,
  timeoutMs = FFMPEG_TIMEOUT_MS,
  cwd,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const append = (current, chunk) => {
      if (current.length >= PROCESS_OUTPUT_LIMIT) return current;
      return (current + chunk.toString('utf8')).slice(0, PROCESS_OUTPUT_LIMIT);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    try {
      child = spawnImpl(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      error.stderr = stderr;
      finish(rejectPromise, error);
      return;
    }

    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => {
      error.stderr = stderr;
      finish(rejectPromise, error);
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish(resolvePromise, { stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`);
      error.code = code;
      error.signal = signal;
      error.stderr = stderr;
      error.stdout = stdout;
      finish(rejectPromise, error);
    });

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The timeout response is still authoritative if the process exited concurrently.
      }
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      error.stderr = stderr;
      error.stdout = stdout;
      finish(rejectPromise, error);
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Convert a spawned-tool failure into the media API's HTTP response contract.
 *
 * @param {string} binary Executable that failed.
 * @param {Error & {code?:string|number, stderr?:string}} error Process error.
 * @returns {{status:number, body:{error:string, hint?:string, stderr?:string}}} HTTP mapping.
 */
export function mapProcessError(binary, error) {
  const dependency = binary === 'yt-dlp' ? 'yt-dlp' : 'ffmpeg';
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr.slice(0, PROCESS_OUTPUT_LIMIT)
    : '';
  if (error?.code === 'ENOENT') {
    return dependency === 'yt-dlp'
      ? {
          status: 501,
          body: {
            error: 'yt-dlp not installed',
            hint: 'Install yt-dlp on the server to enable YouTube ingestion.',
          },
        }
      : {
          status: 501,
          body: {
            error: 'ffmpeg not installed',
            hint: 'Install ffmpeg (including ffprobe) on the server to enable media frame extraction.',
          },
        };
  }
  if (error?.code === 'ETIMEDOUT') {
    return {
      status: 504,
      body: {
        error: `${dependency} timed out`,
        ...(stderr ? { stderr } : {}),
      },
    };
  }
  return {
    status: dependency === 'yt-dlp' ? 502 : 422,
    body: {
      error: `${dependency} failed`,
      ...(stderr ? { stderr } : {}),
    },
  };
}

/**
 * Identify supported image/video data using magic bytes with MIME/filename fallback.
 *
 * @param {Buffer|Uint8Array} bytes Initial media bytes.
 * @param {string} [declaredMime=''] MIME supplied by the client or origin.
 * @param {string} [filename=''] Source filename.
 * @returns {{kind:'video'|'image', mime:string, extension:string}} Detected media type.
 * @throws {Error} When the bytes and hints do not describe supported media.
 */
export function sniffMediaType(bytes, declaredMime = '', filename = '') {
  const head = Buffer.from(bytes || []).subarray(0, 512);
  const ascii = head.toString('ascii').trimStart().toLowerCase();
  if (ascii.startsWith('<!doctype html') || ascii.startsWith('<html')) {
    throw new MediaPipelineError(415, { error: 'URL did not return supported image or video media' });
  }

  let mime = '';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    mime = 'image/jpeg';
  } else if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mime = 'image/png';
  } else if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') {
    mime = 'image/gif';
  } else if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    mime = 'image/webp';
  } else if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') {
    mime = head.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  } else if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    mime = declaredMime.toLowerCase().startsWith('video/x-matroska') ? 'video/x-matroska' : 'video/webm';
  } else if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'AVI ') {
    mime = 'video/x-msvideo';
  } else if (head.subarray(0, 4).toString('ascii') === 'OggS') {
    mime = 'video/ogg';
  } else if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x00
    && head[2] === 0x01 && (head[3] === 0xba || head[3] === 0xb3)) {
    mime = 'video/mpeg';
  }

  const normalizedDeclared = String(declaredMime).split(';', 1)[0].trim().toLowerCase();
  if (!mime && (normalizedDeclared.startsWith('image/') || normalizedDeclared.startsWith('video/'))) {
    mime = normalizedDeclared;
  }
  if (!mime) {
    const extension = extname(String(filename)).slice(1).toLowerCase();
    const inferred = [...MIME_EXTENSIONS.entries()].find(([, ext]) => ext === extension)?.[0];
    if (inferred) mime = inferred;
  }
  if (!mime || (!mime.startsWith('image/') && !mime.startsWith('video/'))) {
    throw new MediaPipelineError(415, { error: 'Unsupported media type' });
  }

  const kind = mime.startsWith('image/') ? 'image' : 'video';
  let extension = MIME_EXTENSIONS.get(mime);
  if (!extension) {
    extension = extname(String(filename)).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  }
  if (!extension) extension = kind === 'image' ? 'jpg' : 'mp4';
  return { kind, mime, extension };
}

/**
 * Parse a multipart/form-data body and return its required `file` part.
 *
 * @param {Buffer} body Complete bounded request body.
 * @param {string} contentType Request Content-Type header.
 * @param {number} maxBytes Maximum accepted file size.
 * @returns {{data:Buffer, filename:string, mime:string}} Parsed file part.
 */
export function parseMultipartFile(body, contentType, maxBytes) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new MediaPipelineError(400, { error: 'Invalid multipart boundary' });
  }

  const marker = Buffer.from(`--${boundary}`);
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  let cursor = 0;
  while (cursor < body.length) {
    const markerIndex = body.indexOf(marker, cursor);
    if (markerIndex === -1) break;
    let partStart = markerIndex + marker.length;
    if (body.subarray(partStart, partStart + 2).toString() === '--') break;
    if (body.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd === -1) break;
    const partEnd = body.indexOf(nextMarker, headerEnd + 4);
    if (partEnd === -1) break;

    const headers = body.subarray(partStart, headerEnd).toString('utf8');
    const disposition = /^content-disposition:\s*form-data;([^\r\n]+)$/im.exec(headers)?.[1] || '';
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (name === 'file') {
      const rawFilename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] || 'upload';
      const mime = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() || '';
      const data = body.subarray(headerEnd + 4, partEnd);
      if (data.length > maxBytes) {
        throw new MediaPipelineError(413, { error: `Media exceeds ${maxBytes} byte limit` });
      }
      if (data.length === 0) throw new MediaPipelineError(400, { error: 'Uploaded file is empty' });
      return { data, filename: safeFilename(rawFilename), mime };
    }
    cursor = partEnd + 2;
  }
  throw new MediaPipelineError(400, { error: 'multipart field "file" is required' });
}

/**
 * Build an Express router implementing the public /api/media endpoints.
 *
 * @param {{
 *   dataDir:string,
 *   spawnImpl?:Function,
 *   fetchImpl?:Function,
 *   maxItems?:number,
 *   maxBytes?:number,
 *   downloadTimeoutMs?:number,
 *   ffmpegTimeoutMs?:number,
 *   ytdlpTimeoutMs?:number,
 *   idFactory?:Function,
 * }} options Runtime path and injectable side effects.
 * @returns {import('express').Router} Router intended for mounting at /api/media.
 */
export function createMediaRouter({
  dataDir,
  spawnImpl = nodeSpawn,
  fetchImpl = globalThis.fetch,
  maxItems = positiveInteger(process.env.LLAMA_MANAGER_MEDIA_MAX_ITEMS, DEFAULT_MAX_ITEMS),
  maxBytes = positiveInteger(process.env.LLAMA_MANAGER_MEDIA_MAX_BYTES, DEFAULT_MAX_BYTES),
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  ffmpegTimeoutMs = FFMPEG_TIMEOUT_MS,
  ytdlpTimeoutMs = YTDLP_TIMEOUT_MS,
  idFactory = () => randomBytes(12).toString('base64url'),
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');

  // Load the server's existing dependency only when a router is actually built,
  // keeping pure-helper tests runnable before npm dependencies are installed.
  const express = require('express');
  const router = express.Router();
  const mediaRoot = resolve(dataDir, 'media');
  const limits = {
    maxItems: positiveInteger(maxItems, DEFAULT_MAX_ITEMS),
    maxBytes: positiveInteger(maxBytes, DEFAULT_MAX_BYTES),
  };
  router.use(express.json({ limit: '1mb' }));

  router.post('/upload', async (req, res) => {
    let item;
    try {
      const body = await readBoundedRequest(req, limits.maxBytes + MULTIPART_OVERHEAD_BYTES);
      const file = parseMultipartFile(body, req.headers['content-type'], limits.maxBytes);
      const detected = sniffMediaType(file.data.subarray(0, 512), file.mime, file.filename);
      item = await createItemDirectory(mediaRoot, idFactory);
      const sourceFile = `source.${detected.extension}`;
      const sourcePath = join(item.dir, sourceFile);
      await writeFile(sourcePath, file.data, { flag: 'wx' });
      const result = await finalizeItem({
        item,
        sourceFile,
        filename: file.filename,
        size: file.data.length,
        ...detected,
      });
      res.json(result);
    } catch (error) {
      await discardItem(item);
      sendMediaError(res, error);
    }
  });

  router.post('/link', async (req, res) => {
    let item;
    try {
      const classification = classifyMediaUrl(req.body?.url);
      if (classification.kind === 'invalid') {
        throw new MediaPipelineError(400, { error: classification.reason });
      }
      if (classification.kind === 'youtube') {
        throw new MediaPipelineError(400, { error: 'Use /api/media/youtube for YouTube URLs' });
      }
      item = await createItemDirectory(mediaRoot, idFactory);
      const downloaded = await downloadDirectMedia({
        url: classification.url,
        item,
        fetchImpl,
        maxBytes: limits.maxBytes,
        timeoutMs: downloadTimeoutMs,
      });
      const result = await finalizeItem({ item, ...downloaded });
      res.json(result);
    } catch (error) {
      await discardItem(item);
      sendMediaError(res, error);
    }
  });

  router.post('/youtube', async (req, res) => {
    let item;
    try {
      const classification = classifyMediaUrl(req.body?.url);
      if (classification.kind !== 'youtube') {
        throw new MediaPipelineError(400, { error: 'A supported YouTube URL is required' });
      }
      item = await createItemDirectory(mediaRoot, idFactory);
      const downloaded = await downloadYouTubeMedia({
        url: classification.url,
        item,
        spawnImpl,
        timeoutMs: ytdlpTimeoutMs,
        maxBytes: limits.maxBytes,
      });
      const result = await finalizeItem({ item, ...downloaded });
      res.json(result);
    } catch (error) {
      await discardItem(item);
      sendMediaError(res, error);
    }
  });

  router.get('/:id/file', async (req, res) => {
    try {
      const stored = await loadStoredMetadata(mediaRoot, req.params.id, true);
      const sourceFile = safeArtifactName(stored.sourceFile);
      res.type(stored.mime);
      res.sendFile(join(mediaRoot, stored.id, sourceFile), error => {
        if (error && !res.headersSent) sendMediaError(res, fileSendError(error));
      });
    } catch (error) {
      sendMediaError(res, error);
    }
  });

  router.get('/:id/frames/:n.jpg', async (req, res) => {
    try {
      const stored = await loadStoredMetadata(mediaRoot, req.params.id, true);
      if (!/^(0|[1-9]\d*)$/.test(req.params.n)) {
        throw new MediaPipelineError(400, { error: 'Invalid frame number' });
      }
      const frameIndex = Number(req.params.n);
      if (frameIndex >= stored.frames.length) {
        throw new MediaPipelineError(404, { error: 'Frame not found' });
      }
      res.type('image/jpeg');
      res.sendFile(join(mediaRoot, stored.id, 'frames', `${frameIndex}.jpg`), error => {
        if (error && !res.headersSent) sendMediaError(res, fileSendError(error));
      });
    } catch (error) {
      sendMediaError(res, error);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const stored = await loadStoredMetadata(mediaRoot, req.params.id, true);
      res.json(publicMetadata(stored));
    } catch (error) {
      sendMediaError(res, error);
    }
  });

  return router;

  async function finalizeItem({ item, sourceFile, filename, size, kind, mime }) {
    const sourcePath = join(item.dir, sourceFile);
    const extracted = await extractFrames({
      sourcePath,
      framesDir: join(item.dir, 'frames'),
      kind,
      spawnImpl,
      ffmpegTimeoutMs,
    });
    const now = new Date().toISOString();
    const stored = {
      id: item.id,
      kind,
      filename: safeFilename(filename || sourceFile),
      size,
      mime,
      url: `/api/media/${item.id}/file`,
      frames: extracted.frames.map(index => `/api/media/${item.id}/frames/${index}.jpg`),
      durationSec: extracted.durationSec,
      sourceFile,
      createdAt: now,
      lastAccessAt: now,
    };
    await writeMetadata(item.dir, stored);
    await pruneMedia(mediaRoot, limits.maxItems, item.id);
    return publicMetadata(stored);
  }
}

async function requiredProcess(binary, args, options) {
  try {
    return await runProcess(binary, args, options);
  } catch (error) {
    const mapped = mapProcessError(binary, error);
    throw new MediaPipelineError(mapped.status, mapped.body, error);
  }
}

async function extractFrames({ sourcePath, framesDir, kind, spawnImpl, ffmpegTimeoutMs }) {
  await mkdir(framesDir, { recursive: true });
  if (kind === 'image') {
    await requiredProcess('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourcePath,
      '-frames:v', '1',
      '-vf', SCALE_FILTER,
      '-q:v', '4',
      join(framesDir, '0.jpg'),
    ], { spawnImpl, timeoutMs: ffmpegTimeoutMs });
    return { durationSec: 0, frames: [0] };
  }

  const probe = await requiredProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    sourcePath,
  ], { spawnImpl, timeoutMs: ffmpegTimeoutMs });
  const durationSec = Number.parseFloat(probe.stdout.trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new MediaPipelineError(422, {
      error: 'Unable to determine video duration',
      ...(probe.stderr ? { stderr: probe.stderr } : {}),
    });
  }

  const timestamps = frameTimestamps(durationSec);
  for (let index = 0; index < timestamps.length; index += 1) {
    await requiredProcess('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', timestamps[index].toFixed(6),
      '-i', sourcePath,
      '-frames:v', '1',
      '-an',
      '-vf', SCALE_FILTER,
      '-q:v', '4',
      join(framesDir, `${index}.jpg`),
    ], { spawnImpl, timeoutMs: ffmpegTimeoutMs });
  }
  return { durationSec, frames: timestamps.map((_, index) => index) };
}

async function downloadDirectMedia({ url, item, fetchImpl, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Llama-Manager media ingestion' },
    });
    if (!response.ok) {
      throw new MediaPipelineError(502, { error: `Media URL returned HTTP ${response.status}` });
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new MediaPipelineError(413, { error: `Media exceeds ${maxBytes} byte limit` });
    }
    if (!response.body) throw new MediaPipelineError(502, { error: 'Media URL returned an empty body' });

    const originFilename = filenameFromResponse(response, url);
    const temporaryPath = join(item.dir, 'download.part');
    const handle = await open(temporaryPath, 'wx');
    const headChunks = [];
    let headLength = 0;
    let size = 0;
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        size += chunk.length;
        if (size > maxBytes) {
          throw new MediaPipelineError(413, { error: `Media exceeds ${maxBytes} byte limit` });
        }
        if (headLength < 512) {
          const headChunk = chunk.subarray(0, 512 - headLength);
          headChunks.push(headChunk);
          headLength += headChunk.length;
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (size === 0) throw new MediaPipelineError(502, { error: 'Media URL returned an empty body' });

    const detected = sniffMediaType(
      Buffer.concat(headChunks),
      response.headers.get('content-type') || '',
      originFilename,
    );
    const sourceFile = `source.${detected.extension}`;
    await rename(temporaryPath, join(item.dir, sourceFile));
    return {
      sourceFile,
      filename: originFilename || sourceFile,
      size,
      ...detected,
    };
  } catch (error) {
    if (error instanceof MediaPipelineError) throw error;
    if (error?.name === 'AbortError') {
      throw new MediaPipelineError(504, { error: 'Media download timed out' }, error);
    }
    throw new MediaPipelineError(502, { error: `Media download failed: ${error.message}` }, error);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadYouTubeMedia({ url, item, spawnImpl, timeoutMs, maxBytes }) {
  await requiredProcess('yt-dlp', [
    '--no-playlist',
    '--max-filesize', String(maxBytes),
    '-f', 'bv*[height<=720]+ba/b[height<=720]',
    '--merge-output-format', 'mp4',
    '-o', join(item.dir, 'source.%(ext)s'),
    url,
  ], { spawnImpl, timeoutMs });

  const entries = await readdir(item.dir, { withFileTypes: true });
  const candidates = entries
    .filter(entry => entry.isFile() && /^source\.[a-zA-Z0-9]+$/.test(entry.name))
    .map(entry => entry.name);
  const sourceFile = candidates.includes('source.mp4') ? 'source.mp4' : candidates[0];
  if (!sourceFile) {
    throw new MediaPipelineError(502, { error: 'yt-dlp completed without a media file' });
  }

  const sourcePath = join(item.dir, sourceFile);
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size > maxBytes) {
    throw new MediaPipelineError(413, { error: `Media exceeds ${maxBytes} byte limit` });
  }
  const handle = await open(sourcePath, 'r');
  const head = Buffer.alloc(512);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(head, 0, head.length, 0));
  } finally {
    await handle.close();
  }
  const detected = sniffMediaType(head.subarray(0, bytesRead), 'video/mp4', sourceFile);
  if (detected.kind !== 'video') {
    throw new MediaPipelineError(415, { error: 'YouTube URL did not produce video media' });
  }
  return {
    sourceFile,
    filename: sourceFile,
    size: sourceStat.size,
    ...detected,
  };
}

async function readBoundedRequest(req, maxBytes) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new MediaPipelineError(413, { error: `Request exceeds ${maxBytes} byte limit` });
  }
  const chunks = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) {
      throw new MediaPipelineError(413, { error: `Request exceeds ${maxBytes} byte limit` });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function createItemDirectory(mediaRoot, idFactory) {
  await mkdir(mediaRoot, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = String(idFactory());
    if (!isSafeMediaId(id)) throw new TypeError('idFactory returned an unsafe media id');
    const dir = join(mediaRoot, id);
    try {
      await mkdir(dir);
      return { id, dir };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new MediaPipelineError(500, { error: 'Unable to allocate media id' });
}

async function loadStoredMetadata(mediaRoot, id, touch) {
  if (!isSafeMediaId(id)) throw new MediaPipelineError(400, { error: 'Invalid media id' });
  let stored;
  try {
    stored = JSON.parse(await readFile(join(mediaRoot, id, 'metadata.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      throw new MediaPipelineError(404, { error: 'Media not found' }, error);
    }
    throw error;
  }
  if (stored.id !== id || !Array.isArray(stored.frames)) {
    throw new MediaPipelineError(404, { error: 'Media not found' });
  }
  if (touch) {
    stored.lastAccessAt = new Date().toISOString();
    await writeMetadata(join(mediaRoot, id), stored);
  }
  return stored;
}

async function writeMetadata(itemDir, stored) {
  const temporary = join(itemDir, `metadata.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(itemDir, 'metadata.json'));
}

async function pruneMedia(mediaRoot, maxItems, preserveId) {
  const entries = await readdir(mediaRoot, { withFileTypes: true });
  const items = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const dir = join(mediaRoot, entry.name);
    try {
      const stored = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
      return { dir, lastAccess: Date.parse(stored.lastAccessAt || stored.createdAt) || 0 };
    } catch {
      const info = await stat(dir);
      return { dir, lastAccess: info.mtimeMs };
    }
  }));
  items.sort((left, right) => left.lastAccess - right.lastAccess);
  const overflow = Math.max(0, items.length - maxItems);
  const deletions = items.filter(item => basename(item.dir) !== preserveId).slice(0, overflow);
  for (const item of deletions) {
    await rm(item.dir, { recursive: true, force: true });
  }
}

async function discardItem(item) {
  if (!item?.dir) return;
  try {
    await rm(item.dir, { recursive: true, force: true });
  } catch {
    // Preserve the original ingestion error if best-effort cleanup fails.
  }
}

function filenameFromResponse(response, originalUrl) {
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded));
    } catch {
      // Fall through to ordinary filename and URL parsing.
    }
  }
  const ordinary = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  if (ordinary) return safeFilename(ordinary);
  try {
    return safeFilename(decodeURIComponent(new URL(response.url || originalUrl).pathname.split('/').pop() || 'download'));
  } catch {
    return 'download';
  }
}

function safeFilename(filename) {
  const cleaned = basename(String(filename || 'media').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 255);
  return cleaned || 'media';
}

function safeArtifactName(filename) {
  if (typeof filename !== 'string' || basename(filename) !== filename || !/^source\.[a-zA-Z0-9]+$/.test(filename)) {
    throw new MediaPipelineError(404, { error: 'Media file not found' });
  }
  return filename;
}

function publicMetadata(stored) {
  return {
    id: stored.id,
    kind: stored.kind,
    filename: stored.filename,
    size: stored.size,
    mime: stored.mime,
    url: stored.url,
    frames: stored.frames,
    durationSec: stored.durationSec,
  };
}

function fileSendError(error) {
  if (error?.code === 'ENOENT') return new MediaPipelineError(404, { error: 'Media artifact not found' }, error);
  return error;
}

function sendMediaError(res, error) {
  if (res.headersSent) return;
  if (error instanceof MediaPipelineError) {
    res.status(error.status).json(error.body);
    return;
  }
  console.error('[media]', error);
  res.status(500).json({ error: 'Media pipeline failed' });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
