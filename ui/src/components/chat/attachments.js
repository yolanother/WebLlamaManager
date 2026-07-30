// Llama Manager — pure multimodal chat attachment helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Classifies pasted content and assembles deterministic OpenAI-compatible
// image, audio, text, and video message parts without depending on browser
// APIs, React, or network access.

const LONG_TEXT_THRESHOLD = 8000;
const VIDEO_EXTENSIONS = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * Classify one absolute URL for smart-paste ingestion.
 *
 * @param {string} value candidate URL
 * @returns {'youtube'|'video'|'other'}
 */
function classifyUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return 'other';

    const hostname = url.hostname.toLowerCase();
    if (YOUTUBE_HOSTS.has(hostname) || hostname.endsWith('.youtube.com')) {
      return 'youtube';
    }
    return VIDEO_EXTENSIONS.test(url.pathname) ? 'video' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Decide whether pasted content should remain text or become an attachment.
 *
 * @param {string} value pasted plain text
 * @returns {{type: string, text?: string, url?: string, kind?: string}}
 */
function classifyPaste(value) {
  const text = String(value ?? '');
  const trimmed = text.trim();
  const urlKind = classifyUrl(trimmed);

  if (trimmed && !/\s/.test(trimmed) && urlKind !== 'other') {
    return { type: 'attachment-url', kind: urlKind, url: trimmed };
  }
  if (text.length > LONG_TEXT_THRESHOLD) {
    return { type: 'text-attachment', text };
  }
  return { type: 'text', text };
}

/**
 * Partition browser files into the media kinds supported by chat attachments.
 *
 * @param {Array<{type?: string}>} files browser file-like objects
 * @returns {{audios: Array<object>, images: Array<object>, videos: Array<object>}}
 */
function partitionMediaFiles(files = []) {
  return {
    audios: files.filter((file) => file?.type?.startsWith('audio/')),
    images: files.filter((file) => file?.type?.startsWith('image/')),
    videos: files.filter((file) => file?.type?.startsWith('video/')),
  };
}

/**
 * Convert a successful media-ingest response into a serializable attachment.
 *
 * @param {{
 *   media?: object,
 *   source?: object,
 *   frames?: Array<object>,
 *   segmentDataUrls?: Array<string>,
 * }} input resolved server media and fetched binary assets
 * @returns {object} ready audio/video attachment state
 */
function buildReadyMediaAttachment({
  media = {},
  source = {},
  frames = [],
  segmentDataUrls = [],
} = {}) {
  const common = {
    kind: media.kind === 'audio' ? 'audio' : 'video',
    filename: media.filename || source.file?.name || source.url,
    mediaId: media.id,
    mime: media.mime,
    size: media.size,
    durationSec: media.durationSec || media.audio?.durationSec || 0,
  };
  if (common.kind === 'audio') {
    return {
      ...common,
      segments: segmentDataUrls.map((dataUrl) => ({ dataUrl, format: 'wav' })),
      status: 'ready',
    };
  }
  return { ...common, frames, status: 'ready' };
}

/**
 * Format seconds as an unbounded MM:SS timestamp.
 *
 * @param {number} seconds duration or frame offset
 * @returns {string}
 */
function formatMediaTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function textAttachmentPart(attachment) {
  const filename = attachment.filename || 'pasted-text.txt';
  const text = String(attachment.text ?? '');
  const fence = text.includes('```') ? '````' : '```';
  return {
    type: 'text',
    text: `[text attachment: ${filename}]\n${fence}text\n${text}\n${fence}`,
  };
}

function videoParts(attachment) {
  const frames = Array.isArray(attachment.frames) ? attachment.frames : [];
  const durationSec = Math.max(0, Number(attachment.durationSec) || 0);
  const parts = [{
    type: 'text',
    text: `[video: ${attachment.filename || 'video'}, duration ${formatMediaTime(durationSec)}]`,
  }];

  frames.forEach((frame, index) => {
    const dataUrl = typeof frame === 'string' ? frame : frame?.dataUrl;
    if (!dataUrl) return;
    const timestampSec = Number.isFinite(frame?.timestampSec)
      ? frame.timestampSec
      : durationSec * index / Math.max(frames.length, 1);
    parts.push({
      type: 'text',
      text: `[frame ${index + 1}/${frames.length} @ ${formatMediaTime(timestampSec)}]`,
    });
    parts.push({ type: 'image_url', image_url: { url: dataUrl } });
  });

  return parts;
}

/**
 * Resolve the OpenAI audio format from explicit segment metadata or its MIME.
 *
 * @param {object} segment ingested audio segment
 * @returns {'wav'|'mp3'} supported OpenAI audio format
 */
function audioFormat(segment) {
  if (segment?.format === 'mp3' || segment?.format === 'wav') return segment.format;
  return /^data:audio\/(?:mpeg|mp3);/i.test(segment?.dataUrl || '') ? 'mp3' : 'wav';
}

/**
 * Convert an ingested audio attachment into standard OpenAI audio parts.
 *
 * @param {object} attachment ready audio attachment with base64 data URLs
 * @returns {Array<object>} descriptive marker followed by audio content parts
 */
function audioParts(attachment) {
  const durationSec = Math.max(0, Number(attachment.durationSec) || 0);
  const parts = [{
    type: 'text',
    text: `[audio: ${attachment.filename || 'audio'}, duration ${formatMediaTime(durationSec)}]`,
  }];

  (attachment.segments || []).forEach((segment) => {
    const dataUrl = String(segment?.dataUrl || '');
    const data = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    if (!data) return;
    parts.push({
      type: 'input_audio',
      input_audio: { data, format: audioFormat(segment) },
    });
  });

  return parts;
}

/**
 * Assemble user content in the server's multimodal video-frame contract.
 * Plain text remains a string for compatibility with existing conversations.
 *
 * @param {{text?: string, attachments?: Array<object>}} input message inputs
 * @returns {string|Array<object>}
 */
function buildMessageContent({ text = '', attachments = [] } = {}) {
  const normalizedText = String(text).trim();
  const readyAttachments = attachments.filter(
    (attachment) => attachment && attachment.status !== 'error' && attachment.status !== 'uploading',
  );
  if (readyAttachments.length === 0) return normalizedText;

  const parts = [];
  if (normalizedText) parts.push({ type: 'text', text: normalizedText });

  readyAttachments.forEach((attachment) => {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      parts.push({
        type: 'image_url',
        image_url: { url: attachment.dataUrl },
      });
    } else if (attachment.kind === 'text') {
      parts.push(textAttachmentPart(attachment));
    } else if (attachment.kind === 'video') {
      parts.push(...videoParts(attachment));
    } else if (attachment.kind === 'audio') {
      parts.push(...audioParts(attachment));
    }
  });

  return parts.length ? parts : normalizedText;
}

export {
  LONG_TEXT_THRESHOLD,
  buildMessageContent,
  buildReadyMediaAttachment,
  classifyPaste,
  classifyUrl,
  formatMediaTime,
  partitionMediaFiles,
};
