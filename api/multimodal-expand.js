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

const DEFAULT_CACHE = new Map();

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
 *   cache?:Map<string, Promise<object>|object>,
 * }} [options] Injectable media expansion dependencies and cache.
 * @returns {Promise<{messages:unknown[], media:object[], warnings:string[]}>}
 *   Expanded messages plus media metadata and non-fatal warnings.
 */
export async function expandMessages(messages, options = {}) {
  if (!containsExtensionPart(messages)) {
    return { messages, media: [], warnings: [] };
  }

  const cache = options.cache || DEFAULT_CACHE;
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
      if (part?.type !== 'video_url') {
        content.push(part);
        continue;
      }
      const expanded = await expandVideoPart(part, { ...options, cache });
      content.push(...expanded.parts);
      media.push(expanded.metadata);
      warnings.push(...expanded.warnings);
    }
    expandedMessages.push({ ...message, content });
  }

  return { messages: expandedMessages, media, warnings };
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
  const sourceKind = classification.kind === 'youtube' ? 'youtube' : 'direct';
  const item = await cachedIngest(url, sourceKind, options);
  const maxFrames = positiveInteger(descriptor.max_frames, 16);
  const frames = Array.isArray(item.frames) ? item.frames.slice(0, maxFrames) : [];
  const timestamps = planSegments(Number(item.durationSec), { maxFrames })
    .flatMap(window => window.frameTimestamps)
    .slice(0, frames.length);
  const parts = [{
    type: 'text',
    text: `[video: ${item.filename || item.id || 'media'}, duration ${formatTimestamp(item.durationSec)}]`,
  }];

  for (let index = 0; index < frames.length; index += 1) {
    parts.push({
      type: 'text',
      text: `[frame ${index + 1}/${frames.length} @ ${formatTimestamp(timestamps[index] || 0)}]`,
    });
    const bytes = await loadBytes(frames[index], options);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    });
  }

  if (descriptor.include_audio !== false && Array.isArray(item.audio?.segments)) {
    for (const artifact of item.audio.segments) {
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
      windows: planSegments(Number(item.durationSec), { maxFrames }).length,
      framesUsed: frames.length,
      digested: false,
    },
    warnings: [],
  };
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
