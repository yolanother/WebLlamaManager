// Llama Manager — pure multimodal chat attachment helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Classifies pasted content and assembles deterministic OpenAI-compatible
// message parts without depending on browser APIs, React, or network access.

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
    }
  });

  return parts.length ? parts : normalizedText;
}

export {
  LONG_TEXT_THRESHOLD,
  buildMessageContent,
  classifyPaste,
  classifyUrl,
  formatMediaTime,
};
