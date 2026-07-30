// Llama Manager — server-side media ingestion and frame-pipeline contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests cover the pure URL, path, frame-selection, and process-error
// contracts without requiring ffmpeg, ffprobe, or yt-dlp on the test host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  classifyMediaUrl,
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
