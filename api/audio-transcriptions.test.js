// Llama Manager — OpenAI-compatible audio transcription endpoint contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests invoke the dependency-injected transcription handler without
// opening sockets, covering multipart compatibility, model capability checks,
// normalized window transcription, response formats, and temporary-file cleanup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createAudioTranscriptionHandler } from './audio-transcriptions.js';

/**
 * Encode text fields and one file using the multipart shape produced by OpenAI clients.
 *
 * @param {string} boundary Multipart boundary token.
 * @param {Record<string, string>} fields Text form fields.
 * @param {{filename:string,mime:string,data:Buffer}} file Uploaded file definition.
 * @returns {Buffer} Complete multipart request body.
 */
function multipartBody(boundary, fields, file) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
  ));
  chunks.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/**
 * Invoke one transcription handler with stream-like request and Express-like response fakes.
 *
 * @param {Function} handler Express request handler.
 * @param {Buffer} body Multipart request body.
 * @param {string} boundary Multipart boundary token.
 * @returns {Promise<object>} Captured response fake.
 */
async function invoke(handler, body, boundary) {
  const request = Readable.from([body]);
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
  await handler(request, response);
  return response;
}

test('OpenAI multipart shape returns JSON text from normalized input_audio and cleans temp files', async () => {
  const boundary = 'openai-python-boundary';
  const body = multipartBody(boundary, {
    model: 'gemma-4-audio.gguf',
    response_format: 'json',
    language: 'en',
    prompt: 'Names: Ada, Charles.',
  }, {
    filename: 'meeting.mp3',
    mime: 'audio/mpeg',
    data: Buffer.from('ID3-demo-audio'),
  });
  const completionBodies = [];
  let temporarySourcePath;
  let temporaryOutputPath;
  const handler = createAudioTranscriptionHandler({
    resolveModelCapabilities: model => {
      assert.equal(model, 'gemma-4-audio.gguf');
      return { audio: true };
    },
    probeDurationImpl: async sourcePath => {
      temporarySourcePath = sourcePath;
      return 42;
    },
    extractAudioImpl: async options => {
      temporaryOutputPath = options.outputPath;
      assert.deepEqual(
        { startSec: options.startSec, endSec: options.endSec },
        { startSec: 0, endSec: 42 },
      );
      await writeFile(options.outputPath, Buffer.from('normalized-wav'));
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:3001/api/v1/chat/completions');
      completionBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Hello from Gemma.' } }] }),
      };
    },
  });

  const response = await invoke(handler, body, boundary);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { text: 'Hello from Gemma.' });
  assert.equal(completionBodies.length, 1);
  assert.equal(completionBodies[0].model, 'gemma-4-audio.gguf');
  assert.deepEqual(completionBodies[0].messages[0].content[1], {
    type: 'input_audio',
    input_audio: {
      data: Buffer.from('normalized-wav').toString('base64'),
      format: 'wav',
    },
  });
  assert.match(completionBodies[0].messages[0].content[0].text, /language hint: en/i);
  assert.match(completionBodies[0].messages[0].content[0].text, /Ada, Charles/);
  await assert.rejects(access(temporarySourcePath), { code: 'ENOENT' });
  await assert.rejects(access(temporaryOutputPath), { code: 'ENOENT' });
});

test('text response_format returns a UTF-8 text/plain body', async () => {
  const boundary = 'text-response-boundary';
  const body = multipartBody(boundary, {
    model: 'gemma-audio',
    response_format: 'text',
  }, {
    filename: 'voice.wav',
    mime: 'audio/wav',
    data: Buffer.from('RIFF-demo-WAVE'),
  });
  const handler = createAudioTranscriptionHandler({
    resolveModelCapabilities: () => ({ audio: true }),
    probeDurationImpl: async () => 5,
    extractAudioImpl: async ({ outputPath }) => writeFile(outputPath, Buffer.from('wav')),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Plain transcript.' } }] }),
    }),
  });

  const response = await invoke(handler, body, boundary);

  assert.equal(response.statusCode, 200);
  assert.equal(response.contentType, 'text/plain; charset=utf-8');
  assert.equal(response.body, 'Plain transcript.');
});

test('verbose_json reports approximate multi-window boundaries and chronological transcripts', async () => {
  const boundary = 'verbose-response-boundary';
  const body = multipartBody(boundary, {
    model: 'gemma-audio',
    response_format: 'verbose_json',
    language: 'fr',
  }, {
    filename: 'long.ogg',
    mime: 'audio/ogg',
    data: Buffer.from('OggS-demo'),
  });
  const extractedWindows = [];
  const transcriptQueue = ['premier', 'deuxième', 'troisième'];
  const handler = createAudioTranscriptionHandler({
    resolveModelCapabilities: () => ({ audio: true }),
    probeDurationImpl: async () => 1_250,
    extractAudioImpl: async options => {
      extractedWindows.push({ startSec: options.startSec, endSec: options.endSec });
      await writeFile(options.outputPath, Buffer.from(`wav-${options.startSec}`));
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: transcriptQueue.shift() } }] }),
    }),
  });

  const response = await invoke(handler, body, boundary);

  assert.deepEqual(extractedWindows, [
    { startSec: 0, endSec: 600 },
    { startSec: 600, endSec: 1_200 },
    { startSec: 1_200, endSec: 1_250 },
  ]);
  assert.deepEqual(response.body, {
    task: 'transcribe',
    language: 'fr',
    duration: 1_250,
    text: 'premier deuxième troisième',
    segments: [
      { id: 0, start: 0, end: 600, text: 'premier' },
      { id: 1, start: 600, end: 1_200, text: 'deuxième' },
      { id: 2, start: 1_200, end: 1_250, text: 'troisième' },
    ],
  });
});

test('missing multipart file is rejected with a clear 400 error', async () => {
  const boundary = 'missing-file-boundary';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngemma-audio\r\n--${boundary}--\r\n`,
  );
  const handler = createAudioTranscriptionHandler({
    resolveModelCapabilities: () => assert.fail('capabilities must not be checked without a file'),
    fetchImpl: async () => assert.fail('backend must not be called without a file'),
  });

  const response = await invoke(handler, body, boundary);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.type, 'invalid_request_error');
  assert.match(response.body.error.message, /multipart field "file" is required/i);
});

test('model without an audio encoder is rejected before normalization', async () => {
  const boundary = 'non-audio-model-boundary';
  const body = multipartBody(boundary, {
    model: 'text-only-model',
  }, {
    filename: 'voice.wav',
    mime: 'audio/wav',
    data: Buffer.from('RIFF-demo-WAVE'),
  });
  const handler = createAudioTranscriptionHandler({
    resolveModelCapabilities: model => {
      assert.equal(model, 'text-only-model');
      return { vision: false, audio: false, source: 'mmproj' };
    },
    probeDurationImpl: async () => assert.fail('non-audio model must not probe the upload'),
    extractAudioImpl: async () => assert.fail('non-audio model must not normalize the upload'),
    fetchImpl: async () => assert.fail('non-audio model must not call chat completions'),
  });

  const response = await invoke(handler, body, boundary);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'model_not_audio_capable');
  assert.match(response.body.error.message, /text-only-model/);
  assert.match(response.body.error.message, /no audio encoder/i);
});

test('both transcription aliases mount the shared handler before the SPA catch-all', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const catchAllIndex = source.indexOf("app.get('*'");

  assert.match(source, /import \{ createAudioTranscriptionHandler \} from '\.\/audio-transcriptions\.js';/);
  assert.match(source, /const handleAudioTranscription = createAudioTranscriptionHandler\(\{/);
  for (const registration of [
    "app.post('/api/v1/audio/transcriptions', handleAudioTranscription);",
    "app.post('/v1/audio/transcriptions', handleAudioTranscription);",
  ]) {
    assert.ok(source.includes(registration), registration);
    assert.ok(source.indexOf(registration) < catchAllIndex, `${registration} must precede SPA fallback`);
  }
});
