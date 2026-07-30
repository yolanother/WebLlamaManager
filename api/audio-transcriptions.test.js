// Llama Manager — OpenAI-compatible audio transcription endpoint contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests invoke the dependency-injected transcription handler without
// opening sockets, covering multipart compatibility, model capability checks,
// normalized window transcription, response formats, and temporary-file cleanup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
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
