// Llama Manager — server-side expansion of URL-based multimodal chat parts.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module converts the additive video_url and audio_url content-part
// extensions into standard OpenAI text, image_url, and input_audio parts before
// upstream inference. It owns media ingestion, artifact loading, URL caching,
// bounded long-media digests, and the response metadata describing expansion.

import { classifyMediaUrl } from './media.js';
import { planSegments } from './media-segments.js';

const MEDIA_DIGEST_PROMPT = 'Describe the speech, visuals, and notable events in this media window. Include useful timestamps and do not speculate beyond the supplied content.';

/**
 * Expand URL-based multimodal extensions in an OpenAI messages array.
 *
 * Standard content parts are returned by reference without invoking any media
 * dependencies, preserving the exact upstream request body for existing clients.
 *
 * @param {unknown[]} messages OpenAI-compatible chat messages.
 * @param {{
 *   ingest?:(url:string, options:{sourceKind:'youtube'|'direct'})=>Promise<object>,
 *   loadArtifact?:(path:string)=>Promise<Buffer|Uint8Array|string>,
 *   complete?:(request:{model?:string,messages:object[]})=>Promise<object|string>,
 *   cache?:Map<string, Promise<object>|object>,
 *   fetchImpl?:Function,
 *   baseUrl?:string,
 *   model?:string,
 * }} [options] Injectable media expansion dependencies, cache, and local API URL.
 * @returns {Promise<{messages:unknown[], media:object[], warnings:string[]}>}
 *   Expanded messages plus media metadata and non-fatal warnings.
 */
export async function expandMessages(messages, options = {}) {
  if (!containsExtensionPart(messages)) {
    return { messages, media: [], warnings: [] };
  }

  const runtimeOptions = resolveOptions(options);
  const cache = runtimeOptions.cache;
  const media = [];
  const warnings = [];
  const expandedMessages = [];

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      expandedMessages.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (part?.type !== 'video_url' && part?.type !== 'audio_url') {
        content.push(part);
        continue;
      }
      let expanded;
      try {
        expanded = part.type === 'video_url'
          ? await expandVideoPart(part, runtimeOptions)
          : await expandAudioPart(part, runtimeOptions);
      } catch (error) {
        const url = part[part.type]?.url;
        content.push(part);
        warnings.push(`${part.type} ${url || '(missing URL)'} was not expanded: ${error.message}`);
        continue;
      }
      content.push(...expanded.parts);
      media.push(expanded.metadata);
      warnings.push(...expanded.warnings);
    }
    expandedMessages.push({ ...message, content });
  }

  return { messages: expandedMessages, media, warnings };
}

/**
 * Fill omitted dependencies with HTTP clients for this server's public media
 * and chat endpoints. Standard-only calls never invoke this setup.
 *
 * @param {object} options Caller-supplied expansion options.
 * @returns {object} Complete runtime options.
 */
function resolveOptions(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:5250').replace(/\/+$/, '');
  return {
    ...options,
    cache: options.cache ?? new Map(),
    ingest: options.ingest || ((url, context) => defaultIngest(url, context, { fetchImpl, baseUrl })),
    loadArtifact: options.loadArtifact || (path => defaultLoadArtifact(path, { fetchImpl, baseUrl })),
    complete: options.complete || (request => defaultComplete(request, { fetchImpl, baseUrl })),
  };
}

/**
 * Ingest a direct or YouTube URL through the existing media API.
 *
 * @param {string} url Source URL.
 * @param {{sourceKind:'youtube'|'direct'}} context Classified ingestion kind.
 * @param {{fetchImpl:Function,baseUrl:string}} runtime HTTP runtime.
 * @returns {Promise<object>} Public media metadata.
 */
async function defaultIngest(url, context, runtime) {
  const endpoint = context.sourceKind === 'youtube' ? 'youtube' : 'link';
  return requestJson(`${runtime.baseUrl}/api/media/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }, runtime.fetchImpl, 'media ingestion');
}

/**
 * Load raw media bytes from an artifact path returned by the media API.
 *
 * @param {string} path Absolute URL or server-relative artifact path.
 * @param {{fetchImpl:Function,baseUrl:string}} runtime HTTP runtime.
 * @returns {Promise<Buffer>} Unencoded artifact bytes.
 */
async function defaultLoadArtifact(path, runtime) {
  const url = /^https?:\/\//i.test(path) ? path : `${runtime.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const response = await runtime.fetchImpl(url);
  if (!response.ok) {
    throw new Error(`media artifact returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Issue an internal non-streaming digest completion through chat/completions.
 *
 * @param {{model?:string,messages:object[]}} request Digest request.
 * @param {{fetchImpl:Function,baseUrl:string}} runtime HTTP runtime.
 * @returns {Promise<object>} OpenAI-compatible completion envelope.
 */
async function defaultComplete(request, runtime) {
  return requestJson(`${runtime.baseUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model || 'default',
      messages: request.messages,
      stream: false,
    }),
  }, runtime.fetchImpl, 'media digest completion');
}

/**
 * Fetch and parse a required JSON response with a concise dependency error.
 *
 * @param {string} url Request URL.
 * @param {object} init Fetch options.
 * @param {Function} fetchImpl Fetch implementation.
 * @param {string} label Dependency label.
 * @returns {Promise<object>} Parsed JSON body.
 */
async function requestJson(url, init, fetchImpl, label) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

/**
 * Expand one audio URL into normalized OpenAI input_audio parts.
 *
 * @param {object} part Audio content part.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<{parts:object[], metadata:object, warnings:string[]}>}
 */
async function expandAudioPart(part, options) {
  const descriptor = part.audio_url || {};
  const classification = classifyMediaUrl(descriptor.url);
  if (classification.kind === 'invalid') throw new TypeError(classification.reason);
  const sourceKind = classification.kind === 'youtube' ? 'youtube' : 'direct';
  const item = await cachedIngest(descriptor.url, sourceKind, options);
  if (!Array.isArray(item.audio?.segments) || item.audio.segments.length === 0) {
    throw new TypeError('ingested media has no normalized audio artifacts');
  }
  const range = mediaRange(item.durationSec, descriptor);
  const processingWindows = rangeWindows(range, 16);
  if (processingWindows.length > 1) {
    return expandLongAudio(item, descriptor, range, processingWindows, options);
  }
  const segments = selectAudioSegments(item, range);
  const warnings = audioRangeWarning('audio_url', descriptor.url, item.durationSec, range);
  const parts = [];
  for (const artifact of segments) {
    const bytes = await loadBytes(artifact, options);
    parts.push({
      type: 'input_audio',
      input_audio: { data: bytes.toString('base64'), format: 'wav' },
    });
  }
  return {
    parts,
    metadata: {
      id: item.id,
      kind: item.kind || 'audio',
      durationSec: Number(item.durationSec) || 0,
      windows: processingWindows.length,
      framesUsed: 0,
      digested: false,
    },
    warnings,
  };
}

/**
 * Map-reduce multi-window audio into timestamped per-window digest text.
 *
 * @param {object} item Ingested audio metadata.
 * @param {object} descriptor Audio content options.
 * @param {{start:number,end:number}} range Requested processing range.
 * @param {Array<{index:number,startSec:number,endSec:number}>} windows Absolute windows.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<{parts:object[],metadata:object,warnings:string[]}>} Digested expansion.
 */
async function expandLongAudio(item, descriptor, range, windows, options) {
  if (typeof options.complete !== 'function') {
    throw new TypeError('expandMessages requires a complete function for long media');
  }
  const audioWindows = planSegments(Number(item.durationSec));
  const audioArtifacts = Array.isArray(item.audio?.segments) ? item.audio.segments : [];
  const summaries = [];
  for (const window of windows) {
    const content = [{
      type: 'text',
      text: `[media window ${window.index + 1}/${windows.length} @ ${formatTimestamp(window.startSec)}-${formatTimestamp(window.endSec)}]`,
    }];
    for (let index = 0; index < audioArtifacts.length; index += 1) {
      const audioWindow = audioWindows[index];
      if (!audioWindow || audioWindow.endSec <= window.startSec || audioWindow.startSec >= window.endSec) continue;
      const bytes = await loadBytes(audioArtifacts[index], options);
      content.push({
        type: 'input_audio',
        input_audio: { data: bytes.toString('base64'), format: 'wav' },
      });
    }
    const completion = await options.complete({
      model: options.model,
      messages: [
        { role: 'system', content: MEDIA_DIGEST_PROMPT },
        { role: 'user', content },
      ],
    });
    summaries.push(completionText(completion));
  }
  const filename = item.filename || item.id || 'media';
  return {
    parts: [{
      type: 'text',
      text: `[media digest: ${filename}]\n${windows.map((window, index) => (
        `[${formatTimestamp(window.startSec)}-${formatTimestamp(window.endSec)}] ${summaries[index]}`
      )).join('\n')}`,
    }],
    metadata: {
      id: item.id,
      kind: item.kind || 'audio',
      durationSec: Number(item.durationSec) || 0,
      windows: windows.length,
      framesUsed: 0,
      digested: true,
    },
    warnings: audioRangeWarning('audio_url', descriptor.url, item.durationSec, range),
  };
}

/**
 * Determine whether the message list contains a URL-based extension part.
 *
 * @param {unknown[]} messages Candidate chat messages.
 * @returns {boolean} True when expansion work is required.
 */
function containsExtensionPart(messages) {
  return Array.isArray(messages) && messages.some(message => (
    Array.isArray(message?.content)
    && message.content.some(part => part?.type === 'video_url' || part?.type === 'audio_url')
  ));
}

/**
 * Expand one video URL using the injected ingestion and artifact seams.
 *
 * @param {object} part Video content part.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<{parts:object[], metadata:object, warnings:string[]}>}
 */
async function expandVideoPart(part, options) {
  const descriptor = part.video_url || {};
  const url = descriptor.url;
  const classification = classifyMediaUrl(url);
  if (classification.kind === 'invalid') throw new TypeError(classification.reason);
  const sourceKind = classification.kind === 'youtube' ? 'youtube' : 'direct';
  const item = await cachedIngest(url, sourceKind, options);
  const maxFrames = positiveInteger(descriptor.max_frames, 16);
  const range = mediaRange(item.durationSec, descriptor);
  const processingWindows = rangeWindows(range, maxFrames);
  if (processingWindows.length > 1) {
    return expandLongVideo(item, descriptor, range, processingWindows, maxFrames, options);
  }
  const frames = selectFrames(item, range, maxFrames);
  const parts = [{
    type: 'text',
    text: `[video: ${item.filename || item.id || 'media'}, duration ${formatTimestamp(item.durationSec)}]`,
  }];

  for (let index = 0; index < frames.length; index += 1) {
    parts.push({
      type: 'text',
      text: `[frame ${index + 1}/${frames.length} @ ${formatTimestamp(frames[index].timestamp)}]`,
    });
    const bytes = await loadBytes(frames[index].artifact, options);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    });
  }

  const audioArtifacts = descriptor.include_audio === false ? [] : selectAudioSegments(item, range);
  if (audioArtifacts.length > 0) {
    for (const artifact of audioArtifacts) {
      const bytes = await loadBytes(artifact, options);
      parts.push({
        type: 'input_audio',
        input_audio: { data: bytes.toString('base64'), format: 'wav' },
      });
    }
  }

  return {
    parts,
    metadata: {
      id: item.id,
      kind: item.kind || 'video',
      durationSec: Number(item.durationSec) || 0,
      windows: processingWindows.length,
      framesUsed: frames.length,
      digested: false,
    },
    warnings: audioArtifacts.length > 0
      ? audioRangeWarning('video_url', url, item.durationSec, range)
      : [],
  };
}

/**
 * Map-reduce a multi-window video into per-window model digests and a bounded
 * representative frame set spanning the requested range.
 *
 * @param {object} item Ingested video metadata.
 * @param {object} descriptor Video content options.
 * @param {{start:number,end:number}} range Requested processing range.
 * @param {Array<{index:number,startSec:number,endSec:number}>} windows Absolute windows.
 * @param {number} maxFrames Frame limit for each digest and final representatives.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<{parts:object[],metadata:object,warnings:string[]}>} Digested expansion.
 */
async function expandLongVideo(item, descriptor, range, windows, maxFrames, options) {
  if (typeof options.complete !== 'function') {
    throw new TypeError('expandMessages requires a complete function for long media');
  }
  const allFrames = mappedFrames(item);
  const audioWindows = planSegments(Number(item.durationSec));
  const audioArtifacts = Array.isArray(item.audio?.segments) ? item.audio.segments : [];
  const summaries = [];

  for (const window of windows) {
    const windowFrames = evenlySelect(
      allFrames.filter(frame => frame.timestamp >= window.startSec && frame.timestamp <= window.endSec),
      maxFrames,
    );
    const content = [{
      type: 'text',
      text: `[media window ${window.index + 1}/${windows.length} @ ${formatTimestamp(window.startSec)}-${formatTimestamp(window.endSec)}]`,
    }];
    for (const frame of windowFrames) {
      const bytes = await loadBytes(frame.artifact, options);
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
      });
    }
    if (descriptor.include_audio !== false) {
      for (let index = 0; index < audioArtifacts.length; index += 1) {
        const audioWindow = audioWindows[index];
        if (!audioWindow || audioWindow.endSec <= window.startSec || audioWindow.startSec >= window.endSec) continue;
        const bytes = await loadBytes(audioArtifacts[index], options);
        content.push({
          type: 'input_audio',
          input_audio: { data: bytes.toString('base64'), format: 'wav' },
        });
      }
    }
    const completion = await options.complete({
      model: options.model,
      messages: [
        { role: 'system', content: MEDIA_DIGEST_PROMPT },
        { role: 'user', content },
      ],
    });
    summaries.push(completionText(completion));
  }

  const filename = item.filename || item.id || 'media';
  const parts = [{
    type: 'text',
    text: `[media digest: ${filename}]\n${windows.map((window, index) => (
      `[${formatTimestamp(window.startSec)}-${formatTimestamp(window.endSec)}] ${summaries[index]}`
    )).join('\n')}`,
  }];
  const representatives = selectFrames(item, range, maxFrames);
  for (let index = 0; index < representatives.length; index += 1) {
    const frame = representatives[index];
    parts.push({
      type: 'text',
      text: `[frame ${index + 1}/${representatives.length} @ ${formatTimestamp(frame.timestamp)}]`,
    });
    const bytes = await loadBytes(frame.artifact, options);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    });
  }

  return {
    parts,
    metadata: {
      id: item.id,
      kind: item.kind || 'video',
      durationSec: Number(item.durationSec) || 0,
      windows: windows.length,
      framesUsed: representatives.length,
      digested: true,
    },
    warnings: descriptor.include_audio !== false && audioArtifacts.length > 0
      ? audioRangeWarning('video_url', descriptor.url, item.durationSec, range)
      : [],
  };
}

/**
 * Normalize an optional start/end range against the known media duration.
 *
 * @param {unknown} durationSec Full media duration.
 * @param {object} descriptor Content-part options.
 * @returns {{start:number,end:number}} Bounded half-open processing range.
 */
function mediaRange(durationSec, descriptor) {
  const duration = Math.max(0, Number(durationSec) || 0);
  const requestedStart = Number(descriptor.start);
  const requestedEnd = Number(descriptor.end);
  const start = Number.isFinite(requestedStart) ? Math.min(duration, Math.max(0, requestedStart)) : 0;
  const end = Number.isFinite(requestedEnd) ? Math.min(duration, Math.max(0, requestedEnd)) : duration;
  if (end <= start) throw new TypeError('media end must be greater than start');
  return { start, end };
}

/**
 * Plan processing windows relative to a requested range, then translate them
 * back to absolute source-media timestamps.
 *
 * @param {{start:number,end:number}} range Requested processing range.
 * @param {number} maxFrames Per-window frame limit.
 * @returns {Array<{index:number,startSec:number,endSec:number,frameTimestamps:number[]}>}
 *   Absolute processing windows.
 */
function rangeWindows(range, maxFrames) {
  return planSegments(range.end - range.start, { maxFrames }).map(window => ({
    ...window,
    startSec: window.startSec + range.start,
    endSec: window.endSec + range.start,
    frameTimestamps: window.frameTimestamps.map(timestamp => timestamp + range.start),
  }));
}

/**
 * Map stored frame artifacts to extraction timestamps, filter by range, and
 * choose an evenly distributed bounded subset.
 *
 * @param {object} item Ingested media metadata.
 * @param {{start:number,end:number}} range Requested processing range.
 * @param {number} maxFrames Maximum selected frames.
 * @returns {Array<{artifact:string,timestamp:number}>} Selected frames.
 */
function selectFrames(item, range, maxFrames) {
  const candidates = mappedFrames(item)
    .filter(frame => frame.timestamp >= range.start && frame.timestamp <= range.end);
  return evenlySelect(candidates, maxFrames);
}

/**
 * Associate stored frame URLs with the deterministic timestamps used by the
 * existing media pipeline.
 *
 * @param {object} item Ingested media metadata.
 * @returns {Array<{artifact:string,timestamp:number}>} Timestamped artifacts.
 */
function mappedFrames(item) {
  const artifacts = Array.isArray(item.frames) ? item.frames : [];
  if (artifacts.length === 0) return [];
  const defaultWindows = Math.max(1, planSegments(Number(item.durationSec)).length);
  const framesPerWindow = Math.max(1, Math.ceil(artifacts.length / defaultWindows));
  const timestamps = planSegments(Number(item.durationSec), { maxFrames: framesPerWindow })
    .flatMap(window => window.frameTimestamps);
  return artifacts.map((artifact, index) => ({
    artifact,
    timestamp: timestamps[index] ?? 0,
  }));
}

/**
 * Choose a bounded, evenly distributed subset while preserving chronology.
 *
 * @template T
 * @param {T[]} values Ordered candidates.
 * @param {number} limit Maximum result count.
 * @returns {T[]} Evenly distributed values.
 */
function evenlySelect(values, limit) {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor(((index + 0.5) * values.length) / limit)]
  ));
}

/**
 * Select stored audio windows that intersect a requested media range.
 *
 * @param {object} item Ingested media metadata.
 * @param {{start:number,end:number}} range Requested processing range.
 * @returns {string[]} Intersecting normalized WAV artifacts.
 */
function selectAudioSegments(item, range) {
  const artifacts = Array.isArray(item.audio?.segments) ? item.audio.segments : [];
  const windows = planSegments(Number(item.durationSec));
  return artifacts.filter((artifact, index) => {
    const window = windows[index];
    return artifact && window && window.endSec > range.start && window.startSec < range.end;
  });
}

/**
 * Explain when requested audio bounds can only be approximated by stored WAV
 * windows, ensuring callers are never led to believe the audio was sample-trimmed.
 *
 * @param {'audio_url'|'video_url'} partType Extension content-part type.
 * @param {string} url Source media URL.
 * @param {unknown} durationSec Full media duration.
 * @param {{start:number,end:number}} range Requested processing range.
 * @returns {string[]} Empty for exact boundaries, otherwise one warning.
 */
function audioRangeWarning(partType, url, durationSec, range) {
  const windows = planSegments(Number(durationSec));
  const exactStart = range.start === 0 || windows.some(window => window.startSec === range.start);
  const exactEnd = range.end === Number(durationSec) || windows.some(window => window.endSec === range.end);
  if (exactStart && exactEnd) return [];
  return [
    `${partType} ${url} requested ${formatTimestamp(range.start)}-${formatTimestamp(range.end)}; normalized audio uses intersecting stored window boundaries`,
  ];
}

/**
 * Read digest text from either an OpenAI completion envelope or a direct string.
 *
 * @param {unknown} completion Injected completion result.
 * @returns {string} Non-empty digest text.
 * @throws {TypeError} When no digest text is available.
 */
function completionText(completion) {
  const value = typeof completion === 'string'
    ? completion
    : completion?.choices?.[0]?.message?.content;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('media digest completion returned no text');
  }
  return value.trim();
}

/**
 * Reuse one ingestion result for repeated URLs while evicting failed promises.
 *
 * @param {string} url Media URL cache key.
 * @param {'youtube'|'direct'} sourceKind Ingestion endpoint kind.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<object>} Ingested public media metadata.
 */
async function cachedIngest(url, sourceKind, options) {
  if (typeof options.ingest !== 'function') throw new TypeError('expandMessages requires an ingest function');
  if (!options.cache.has(url)) {
    const pending = Promise.resolve(options.ingest(url, { sourceKind }));
    options.cache.set(url, pending);
    pending.catch(() => options.cache.delete(url));
  }
  return options.cache.get(url);
}

/**
 * Load an artifact and normalize its payload to a Buffer.
 *
 * @param {string} path Media artifact URL or path.
 * @param {object} options Expansion dependencies.
 * @returns {Promise<Buffer>} Artifact bytes.
 */
async function loadBytes(path, options) {
  if (typeof options.loadArtifact !== 'function') {
    throw new TypeError('expandMessages requires a loadArtifact function');
  }
  const value = await options.loadArtifact(path);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/**
 * Format seconds as a stable MM:SS timestamp.
 *
 * @param {unknown} seconds Candidate duration or offset.
 * @returns {string} Zero-padded timestamp.
 */
function formatTimestamp(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Resolve a positive integer option or its fallback.
 *
 * @param {unknown} value Candidate value.
 * @param {number} fallback Default value.
 * @returns {number} Positive integer.
 */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
