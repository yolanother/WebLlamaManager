// Llama Manager — server-side media ingestion and frame-pipeline contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests cover the pure URL, path, frame-selection, and process-error
// contracts without requiring ffmpeg, ffprobe, or yt-dlp on the test host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  classifyMediaUrl,
  createMediaRouter,
  extractAudio,
  frameTimestamps,
  isSafeMediaId,
  mapProcessError,
  runProcess,
  sniffMediaType,
} from './media.js';

function mockChildProcess({ error, code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };

  queueMicrotask(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', code, null);
  });
  return child;
}

function createRouterHarness(routerOptions) {
  const routes = new Map();
  const router = {
    use() {},
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
  const expressImpl = {
    Router: () => router,
    json: () => () => {},
  };
  createMediaRouter({ ...routerOptions, expressImpl });
  return routes;
}

async function invokeRoute(routes, method, path, { body, headers = {}, params = {} } = {}) {
  const request = body instanceof Buffer ? Readable.from([body]) : Readable.from([]);
  request.body = body instanceof Buffer ? undefined : body;
  request.headers = headers;
  request.params = params;
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
    sendFile(filePath, callback) {
      try {
        this.payload = readFileSync(filePath);
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    },
  };
  await routes.get(`${method} ${path}`)(request, response);
  return response;
}

function multipartFileBody(boundary, filename, mime, data) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test('classifyMediaUrl accepts only HTTP(S) direct and supported YouTube URLs', () => {
  assert.equal(classifyMediaUrl('https://cdn.example.test/movie.mp4').kind, 'direct');
  assert.equal(classifyMediaUrl('http://example.test/image.png').kind, 'direct');
  assert.equal(classifyMediaUrl('https://www.youtube.com/watch?v=abcdefghijk').kind, 'youtube');
  assert.equal(classifyMediaUrl('https://youtu.be/abcdefghijk?t=4').kind, 'youtube');
  assert.equal(classifyMediaUrl('https://youtube.com/shorts/abcdefghijk').kind, 'youtube');

  assert.equal(classifyMediaUrl('ftp://example.test/movie.mp4').kind, 'invalid');
  assert.equal(classifyMediaUrl('file:///etc/passwd').kind, 'invalid');
  assert.equal(classifyMediaUrl('https://youtube.com.evil.test/watch?v=abcdefghijk').kind, 'direct');
  assert.equal(classifyMediaUrl('not a url').kind, 'invalid');
});

test('media ids reject separators, traversal, dots, and empty values', () => {
  for (const id of ['abc123', 'AbC_123-x', '0']) assert.equal(isSafeMediaId(id), true);
  for (const id of ['', '.', '..', '../x', 'x/y', 'x\\y', 'space here', '%2e%2e']) {
    assert.equal(isSafeMediaId(id), false, id);
  }
});

test('frame timestamps are evenly spaced inside the duration and capped at 16', () => {
  assert.deepEqual(frameTimestamps(0), []);
  assert.deepEqual(frameTimestamps(Number.NaN), []);
  assert.deepEqual(frameTimestamps(0.5), [0.25]);
  assert.deepEqual(frameTimestamps(2), [2 / 3, 4 / 3]);

  const timestamps = frameTimestamps(120);
  assert.equal(timestamps.length, 16);
  assert.ok(timestamps[0] > 0);
  assert.ok(timestamps.at(-1) < 120);
  const spacing = timestamps[1] - timestamps[0];
  for (let i = 2; i < timestamps.length; i += 1) {
    assert.ok(Math.abs((timestamps[i] - timestamps[i - 1]) - spacing) < 1e-9);
  }
});

test('sniffMediaType recognizes supported audio formats from magic bytes', () => {
  const cases = [
    ['wav', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary'), 'audio/wav', 'wav'],
    ['mp3 ID3', Buffer.from('ID3\x04\x00\x00', 'binary'), 'audio/mpeg', 'mp3'],
    ['mp3 frame', Buffer.from([0xff, 0xfb, 0x90, 0x64]), 'audio/mpeg', 'mp3'],
    ['flac', Buffer.from('fLaC\x00\x00\x00\x22', 'binary'), 'audio/flac', 'flac'],
    ['ogg', Buffer.from('OggS\x00\x02', 'binary'), 'audio/ogg', 'ogg'],
    ['m4a', Buffer.from('\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00', 'binary'), 'audio/mp4', 'm4a'],
  ];

  for (const [label, bytes, mime, extension] of cases) {
    assert.deepEqual(sniffMediaType(bytes), { kind: 'audio', mime, extension }, label);
  }
});

test('runProcess captures stdout and stderr from a mocked successful spawn', async () => {
  const calls = [];
  const result = await runProcess('ffprobe', ['input.mp4'], {
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return mockChildProcess({ stdout: '12.5\n', stderr: 'warning\n' });
    },
  });

  assert.equal(result.stdout, '12.5\n');
  assert.equal(result.stderr, 'warning\n');
  assert.deepEqual(calls[0].args, ['input.mp4']);
  assert.equal(calls[0].options.shell, false);
});

test('extractAudio normalizes a bounded source window to 16 kHz mono PCM WAV', async () => {
  const calls = [];
  await extractAudio({
    sourcePath: '/media/source.mp4',
    outputPath: '/media/audio/1.wav',
    startSec: 600,
    endSec: 650,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return mockChildProcess();
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.deepEqual(calls[0].args, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '600.000000',
    '-i', '/media/source.mp4',
    '-t', '50.000000',
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '/media/audio/1.wav',
  ]);
});

test('video upload exposes and serves one normalized audio file per planned window', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'llama-media-test-'));
  const calls = [];
  try {
    const routes = createRouterHarness({
      dataDir,
      idFactory: () => 'video-audio-id',
      spawnImpl(command, args) {
        calls.push({ command, args });
        if (command === 'ffprobe') return mockChildProcess({ stdout: '1250\n' });
        const outputPath = args.at(-1);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, args.includes('-vn') ? Buffer.from('normalized-wav') : Buffer.from('jpeg'));
        return mockChildProcess();
      },
    });
    const boundary = 'llama-media-boundary';
    const uploadBody = multipartFileBody(
      boundary,
      'long.mp4',
      'video/mp4',
      Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00', 'binary'),
    );
    const uploaded = await invokeRoute(routes, 'POST', '/upload', {
      body: uploadBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(uploadBody.length),
      },
    });
    assert.equal(uploaded.statusCode, 200);
    const metadata = uploaded.body;
      assert.equal(metadata.kind, 'video');
      assert.equal(metadata.durationSec, 1_250);
      assert.equal(metadata.frames.length, 48);
      assert.deepEqual(metadata.audio, {
        segments: [
          '/api/media/video-audio-id/audio/0.wav',
          '/api/media/video-audio-id/audio/1.wav',
          '/api/media/video-audio-id/audio/2.wav',
        ],
        durationSec: 1_250,
        sampleRate: 16_000,
        channels: 1,
      });

    const audio = await invokeRoute(routes, 'GET', '/:id/audio/:n.wav', {
      params: { id: 'video-audio-id', n: '1' },
    });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.contentType, 'audio/wav');
    assert.deepEqual(audio.payload, Buffer.from('normalized-wav'));

    const audioCalls = calls.filter(call => call.command === 'ffmpeg' && call.args.includes('-vn'));
    assert.equal(audioCalls.length, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('audio upload normalizes sound without attempting video frame extraction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'llama-media-test-'));
  const calls = [];
  try {
    const routes = createRouterHarness({
      dataDir,
      idFactory: () => 'audio-only-id',
      spawnImpl(command, args) {
        calls.push({ command, args });
        if (command === 'ffprobe') return mockChildProcess({ stdout: '30\n' });
        const outputPath = args.at(-1);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, Buffer.from('normalized-wav'));
        return mockChildProcess();
      },
    });
    const boundary = 'llama-audio-boundary';
    const uploadBody = multipartFileBody(
      boundary,
      'voice.wav',
      'audio/wav',
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary'),
    );
    const uploaded = await invokeRoute(routes, 'POST', '/upload', {
      body: uploadBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(uploadBody.length),
      },
    });

    assert.equal(uploaded.statusCode, 200);
    assert.equal(uploaded.body.kind, 'audio');
    assert.deepEqual(uploaded.body.frames, []);
    assert.deepEqual(uploaded.body.audio, {
      segments: ['/api/media/audio-only-id/audio/0.wav'],
      durationSec: 30,
      sampleRate: 16_000,
      channels: 1,
    });
    assert.equal(calls.filter(call => call.command === 'ffmpeg' && call.args.includes('-vn')).length, 1);
    assert.equal(calls.filter(call => call.command === 'ffmpeg' && call.args.includes('-frames:v')).length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('image and short-video frame extraction remains byte-for-byte unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'llama-media-test-'));
  const ids = ['image-id', 'short-video-id'];
  const calls = [];
  try {
    const routes = createRouterHarness({
      dataDir,
      idFactory: () => ids.shift(),
      spawnImpl(command, args) {
        calls.push({ command, args });
        if (command === 'ffprobe') return mockChildProcess({ stdout: '2\n' });
        const outputPath = args.at(-1);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, args.includes('-vn') ? Buffer.from('wav') : Buffer.from('unchanged-jpeg'));
        return mockChildProcess();
      },
    });

    const imageBoundary = 'llama-image-boundary';
    const imageBody = multipartFileBody(
      imageBoundary,
      'still.jpg',
      'image/jpeg',
      Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
    );
    const imageUpload = await invokeRoute(routes, 'POST', '/upload', {
      body: imageBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${imageBoundary}`,
        'content-length': String(imageBody.length),
      },
    });
    assert.deepEqual(imageUpload.body.frames, ['/api/media/image-id/frames/0.jpg']);
    assert.equal(imageUpload.body.audio, undefined);

    const videoBoundary = 'llama-short-video-boundary';
    const videoBody = multipartFileBody(
      videoBoundary,
      'short.mp4',
      'video/mp4',
      Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00', 'binary'),
    );
    const videoUpload = await invokeRoute(routes, 'POST', '/upload', {
      body: videoBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${videoBoundary}`,
        'content-length': String(videoBody.length),
      },
    });
    assert.deepEqual(videoUpload.body.frames, [
      '/api/media/short-video-id/frames/0.jpg',
      '/api/media/short-video-id/frames/1.jpg',
    ]);

    const imageFrame = await invokeRoute(routes, 'GET', '/:id/frames/:n.jpg', {
      params: { id: 'image-id', n: '0' },
    });
    const videoFrame = await invokeRoute(routes, 'GET', '/:id/frames/:n.jpg', {
      params: { id: 'short-video-id', n: '1' },
    });
    assert.deepEqual(imageFrame.payload, Buffer.from('unchanged-jpeg'));
    assert.deepEqual(videoFrame.payload, Buffer.from('unchanged-jpeg'));

    const frameCalls = calls.filter(call => call.command === 'ffmpeg' && !call.args.includes('-vn'));
    assert.deepEqual(frameCalls.map(call => call.args), [
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', join(dataDir, 'media', 'image-id', 'source.jpg'),
        '-frames:v', '1',
        '-vf', "scale=w='if(gte(iw,ih),min(iw,768),-2)':h='if(lt(iw,ih),min(ih,768),-2)'",
        '-q:v', '4',
        join(dataDir, 'media', 'image-id', 'frames', '0.jpg'),
      ],
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', '0.666667',
        '-i', join(dataDir, 'media', 'short-video-id', 'source.mp4'),
        '-frames:v', '1',
        '-an',
        '-vf', "scale=w='if(gte(iw,ih),min(iw,768),-2)':h='if(lt(iw,ih),min(ih,768),-2)'",
        '-q:v', '4',
        join(dataDir, 'media', 'short-video-id', 'frames', '0.jpg'),
      ],
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', '1.333333',
        '-i', join(dataDir, 'media', 'short-video-id', 'source.mp4'),
        '-frames:v', '1',
        '-an',
        '-vf', "scale=w='if(gte(iw,ih),min(iw,768),-2)':h='if(lt(iw,ih),min(ih,768),-2)'",
        '-q:v', '4',
        join(dataDir, 'media', 'short-video-id', 'frames', '1.jpg'),
      ],
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('audio upload reports a 501 with an installation hint when ffmpeg is missing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'llama-media-test-'));
  try {
    const routes = createRouterHarness({
      dataDir,
      idFactory: () => 'missing-ffmpeg-id',
      spawnImpl(command) {
        if (command === 'ffprobe') return mockChildProcess({ stdout: '10\n' });
        const missing = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
        return mockChildProcess({ error: missing });
      },
    });
    const boundary = 'llama-missing-ffmpeg-boundary';
    const uploadBody = multipartFileBody(
      boundary,
      'voice.wav',
      'audio/wav',
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary'),
    );
    const uploaded = await invokeRoute(routes, 'POST', '/upload', {
      body: uploadBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(uploadBody.length),
      },
    });

    assert.equal(uploaded.statusCode, 501);
    assert.equal(uploaded.body.error, 'ffmpeg not installed');
    assert.match(uploaded.body.hint, /install ffmpeg/i);
    assert.match(uploaded.body.hint, /audio extraction/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('missing yt-dlp and ffmpeg processes map to graceful 501 responses', async () => {
  for (const binary of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    const missing = Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    let caught;
    await assert.rejects(
      runProcess(binary, [], { spawnImpl: () => mockChildProcess({ error: missing }) }),
      error => {
        caught = error;
        return true;
      },
    );
    const mapped = mapProcessError(binary, caught);
    assert.equal(mapped.status, 501);
    assert.equal(mapped.body.error, binary === 'yt-dlp' ? 'yt-dlp not installed' : 'ffmpeg not installed');
    assert.match(mapped.body.hint, /install/i);
  }
});

test('process failures retain bounded stderr and timeouts map to 504', async () => {
  let failure;
  await assert.rejects(
    runProcess('ffmpeg', [], {
      spawnImpl: () => mockChildProcess({ code: 1, stderr: `decoder failed\n${'x'.repeat(20_000)}` }),
    }),
    error => {
      failure = error;
      return true;
    },
  );
  const failed = mapProcessError('ffmpeg', failure);
  assert.equal(failed.status, 422);
  assert.match(failed.body.stderr, /decoder failed/);
  assert.ok(failed.body.stderr.length <= 16_384);

  const timedOut = mapProcessError(
    'yt-dlp',
    Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stderr: 'last output' }),
  );
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.stderr, 'last output');
});
