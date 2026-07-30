// Llama Manager — OpenAI-compatible audio transcription request handling.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module parses bounded multipart transcription uploads, verifies that the
// requested local model has a native audio encoder, normalizes fixed audio
// windows to 16 kHz mono WAV, and transcribes them through chat completions.
// verbose_json segment timings are approximate window edges, not detected speech
// boundaries or word-level timestamps; Gemma is not a dedicated ASR model.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { extractAudio, parseMultipartFile, runProcess } from './media.js';
import { planSegments } from './media-segments.js';

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_TEXT_FIELDS_BYTES = 64 * 1024;
const DEFAULT_CHAT_COMPLETIONS_URL = 'http://127.0.0.1:3001/api/v1/chat/completions';

/**
 * HTTP-aware error used to map endpoint failures to OpenAI-style responses.
 */
class AudioTranscriptionError extends Error {
  /**
   * Create a transcription request error.
   *
   * @param {number} status HTTP status code.
   * @param {string} message Client-safe error explanation.
   * @param {string} code Stable machine-readable error code.
   * @param {unknown} [cause] Optional underlying failure.
   */
  constructor(status, message, code, cause) {
    super(message, { cause });
    this.name = 'AudioTranscriptionError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Build an Express handler for OpenAI-compatible audio transcription requests.
 * Dependencies are injectable so behavioral tests do not open sockets or invoke
 * ffmpeg/ffprobe.
 *
 * @param {{
 *   resolveModelCapabilities:Function,
 *   fetchImpl?:Function,
 *   spawnImpl?:Function,
 *   probeDurationImpl?:Function,
 *   extractAudioImpl?:Function,
 *   maxBytes?:number,
 *   chatCompletionsUrl?:string,
 *   temporaryRoot?:string,
 * }} options Runtime dependencies and request limits.
 * @returns {Function} Async Express request handler.
 */
export function createAudioTranscriptionHandler({
  resolveModelCapabilities,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  probeDurationImpl = sourcePath => probeAudioDuration(sourcePath, { spawnImpl }),
  extractAudioImpl = extractAudio,
  maxBytes = DEFAULT_MAX_BYTES,
  chatCompletionsUrl = DEFAULT_CHAT_COMPLETIONS_URL,
  temporaryRoot = tmpdir(),
} = {}) {
  if (typeof resolveModelCapabilities !== 'function') {
    throw new TypeError('resolveModelCapabilities is required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');

  return async function handleAudioTranscription(req, res) {
    let workDir;
    try {
      const body = await readBoundedRequest(req, maxBytes + MULTIPART_OVERHEAD_BYTES);
      const contentType = req.headers['content-type'];
      const file = parseMultipartFile(body, contentType, maxBytes);
      const fields = parseMultipartTextFields(body, contentType);
      const model = fields.model?.trim();
      if (!model) {
        throw new AudioTranscriptionError(400, 'multipart field "model" is required', 'missing_model');
      }
      const capabilities = resolveModelCapabilities(model);
      if (!capabilities?.audio) {
        throw new AudioTranscriptionError(
          400,
          `Model "${model}" cannot transcribe audio because it has no audio encoder`,
          'model_not_audio_capable',
        );
      }
      const responseFormat = fields.response_format?.trim() || 'json';
      if (!['json', 'text', 'verbose_json'].includes(responseFormat)) {
        throw new AudioTranscriptionError(
          400,
          `Unsupported response_format "${responseFormat}"`,
          'invalid_response_format',
        );
      }

      workDir = await mkdtemp(join(temporaryRoot, 'llama-manager-transcription-'));
      const sourcePath = join(workDir, `source${safeExtension(file.filename)}`);
      await writeFile(sourcePath, file.data);
      const durationSec = await probeDurationImpl(sourcePath);
      const windows = planSegments(durationSec);
      if (!windows.length) {
        throw new AudioTranscriptionError(422, 'Unable to determine audio duration', 'invalid_audio_duration');
      }

      const transcripts = [];
      for (const window of windows) {
        const outputPath = join(workDir, `${window.index}.wav`);
        await extractAudioImpl({
          sourcePath,
          outputPath,
          startSec: window.startSec,
          endSec: window.endSec,
          spawnImpl,
        });
        const audio = await readFile(outputPath);
        transcripts.push(await transcribeWindow({
          audio,
          model,
          language: fields.language,
          prompt: fields.prompt,
          fetchImpl,
          chatCompletionsUrl,
        }));
      }

      const text = concatenateTranscripts(transcripts);
      if (responseFormat === 'text') {
        res.type('text/plain; charset=utf-8').send(text);
      } else if (responseFormat === 'verbose_json') {
        res.json({
          task: 'transcribe',
          language: fields.language?.trim() || 'unknown',
          duration: durationSec,
          text,
          segments: windows.map((window, index) => ({
            id: window.index,
            start: window.startSec,
            end: window.endSec,
            text: transcripts[index],
          })),
        });
      } else {
        res.json({ text });
      }
    } catch (error) {
      sendTranscriptionError(res, error);
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  };
}

/**
 * Read a request stream while enforcing the endpoint's existing 200 MB body policy.
 *
 * @param {AsyncIterable<Buffer>|object} request Incoming HTTP request.
 * @param {number} maxBytes Maximum accepted multipart body size.
 * @returns {Promise<Buffer>} Complete bounded request body.
 */
async function readBoundedRequest(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AudioTranscriptionError(413, `Request exceeds ${maxBytes} byte limit`, 'request_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) {
      throw new AudioTranscriptionError(413, `Request exceeds ${maxBytes} byte limit`, 'request_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Parse non-file multipart fields without widening the media module's file-only contract.
 *
 * @param {Buffer} body Complete bounded multipart body.
 * @param {string} contentType Request Content-Type header.
 * @returns {Record<string, string>} Recognized text field values.
 */
function parseMultipartTextFields(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new AudioTranscriptionError(400, 'Invalid multipart boundary', 'invalid_multipart');
  }

  const fields = {};
  const allowedFields = new Set(['model', 'response_format', 'language', 'prompt']);
  const marker = Buffer.from(`--${boundary}`);
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  let cursor = 0;
  let textBytes = 0;
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
    const hasFilename = /(?:^|;)\s*filename="[^"]*"/i.test(disposition);
    if (!hasFilename && allowedFields.has(name)) {
      const data = body.subarray(headerEnd + 4, partEnd);
      textBytes += data.length;
      if (textBytes > MAX_TEXT_FIELDS_BYTES) {
        throw new AudioTranscriptionError(413, 'Multipart text fields are too large', 'fields_too_large');
      }
      fields[name] = data.toString('utf8');
    }
    cursor = partEnd + 2;
  }
  return fields;
}

/**
 * Return a conservative upload extension for ffmpeg input probing.
 *
 * @param {string} filename Client-provided sanitized filename.
 * @returns {string} Dot-prefixed lowercase extension or an empty string.
 */
function safeExtension(filename) {
  const extension = extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

/**
 * Probe the duration of an uploaded audio source with bounded process output.
 *
 * @param {string} sourcePath Temporary source path.
 * @param {{spawnImpl?:Function}} options Injectable child-process dependency.
 * @returns {Promise<number>} Positive duration in seconds.
 */
async function probeAudioDuration(sourcePath, { spawnImpl } = {}) {
  let result;
  try {
    result = await runProcess('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      sourcePath,
    ], { spawnImpl });
  } catch (error) {
    throw new AudioTranscriptionError(422, 'Unable to inspect uploaded audio', 'audio_probe_failed', error);
  }
  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AudioTranscriptionError(422, 'Unable to determine audio duration', 'invalid_audio_duration');
  }
  return duration;
}

/**
 * Transcribe one normalized WAV window through an OpenAI chat completion.
 *
 * @param {{audio:Buffer,model:string,language?:string,prompt?:string,fetchImpl:Function,chatCompletionsUrl:string}} options Window and completion dependencies.
 * @returns {Promise<string>} Trimmed transcript text.
 */
async function transcribeWindow({
  audio,
  model,
  language,
  prompt,
  fetchImpl,
  chatCompletionsUrl,
}) {
  const response = await fetchImpl(chatCompletionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: transcriptionInstruction(language, prompt) },
          {
            type: 'input_audio',
            input_audio: { data: audio.toString('base64'), format: 'wav' },
          },
        ],
      }],
    }),
  });
  if (!response.ok) {
    throw new AudioTranscriptionError(
      502,
      `Chat completion failed with HTTP ${response.status}`,
      'transcription_backend_error',
    );
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('')
      : '';
  if (!text.trim()) {
    throw new AudioTranscriptionError(502, 'Chat completion returned no transcript', 'empty_transcript');
  }
  return text.trim();
}

/**
 * Build the fixed transcription instruction with optional OpenAI hints.
 *
 * @param {string|undefined} language Optional ISO language hint.
 * @param {string|undefined} prompt Optional vocabulary or style hint.
 * @returns {string} Plain transcription instruction.
 */
function transcriptionInstruction(language, prompt) {
  const hints = [];
  if (language?.trim()) hints.push(`Language hint: ${language.trim()}.`);
  if (prompt?.trim()) hints.push(`Vocabulary/context hint: ${prompt.trim()}`);
  return [
    'Transcribe the spoken audio exactly. Return only the transcript, without commentary or timestamps.',
    ...hints,
  ].join('\n');
}

/**
 * Concatenate chronological window transcripts into one plain transcript.
 *
 * @param {string[]} transcripts Per-window transcript strings.
 * @returns {string} Combined transcript.
 */
function concatenateTranscripts(transcripts) {
  return transcripts.filter(Boolean).join(' ').trim();
}

/**
 * Send a stable OpenAI-style error envelope while preserving media parser errors.
 *
 * @param {object} response Express response.
 * @param {Error & {status?:number,body?:object,code?:string}} error Request failure.
 * @returns {object} Express response result.
 */
function sendTranscriptionError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const mediaMessage = typeof error?.body?.error === 'string' ? error.body.error : null;
  const message = mediaMessage || (status < 500 ? error.message : 'Audio transcription failed');
  return response.status(status).json({
    error: {
      message,
      type: status < 500 ? 'invalid_request_error' : 'server_error',
      code: error?.code || (status < 500 ? 'invalid_request' : 'transcription_failed'),
    },
  });
}
