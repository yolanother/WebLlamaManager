// Llama Manager — behavioral tests for server-side multimodal content expansion.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests exercise the public expandMessages interface with injected media
// and completion dependencies, verifying OpenAI-standard parts remain unchanged
// while URL-based audio and video extensions become standard content parts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { expandMessages } from './multimodal-expand.js';

test('standard OpenAI content parts preserve the exact upstream request body', async () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Y2F0' } },
      { type: 'input_audio', input_audio: { data: 'c291bmQ=', format: 'wav' } },
    ],
  }];
  const request = { model: 'gemma-4', messages, temperature: 0.25 };
  const before = JSON.stringify(request);

  const result = await expandMessages(messages, {
    ingest: async () => assert.fail('standard parts must not trigger ingestion'),
  });

  assert.strictEqual(result.messages, messages);
  assert.deepEqual(result, { messages, media: [], warnings: [] });
  assert.equal(JSON.stringify({ ...request, messages: result.messages }), before);
});

test('YouTube video_url expands to labelled frames and normalized audio', async () => {
  const calls = [];
  const messages = [{
    role: 'user',
    content: [{
      type: 'video_url',
      video_url: {
        url: 'https://youtu.be/demo123',
        max_frames: 2,
      },
    }],
  }];

  const result = await expandMessages(messages, {
    cache: new Map(),
    ingest: async (url, options) => {
      calls.push({ url, options });
      return {
        id: 'youtube-1',
        kind: 'video',
        filename: 'launch.mp4',
        durationSec: 90,
        frames: ['/api/media/youtube-1/frames/0.jpg', '/api/media/youtube-1/frames/1.jpg'],
        audio: { segments: ['/api/media/youtube-1/audio/0.wav'] },
      };
    },
    loadArtifact: async path => Buffer.from(path.includes('frames/0') ? 'frame-zero' : path.includes('frames/1') ? 'frame-one' : 'audio-zero'),
  });

  assert.deepEqual(calls, [{
    url: 'https://youtu.be/demo123',
    options: { sourceKind: 'youtube' },
  }]);
  assert.deepEqual(result.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: '[video: launch.mp4, duration 01:30]' },
      { type: 'text', text: '[frame 1/2 @ 00:30]' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('frame-zero').toString('base64')}` } },
      { type: 'text', text: '[frame 2/2 @ 01:00]' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('frame-one').toString('base64')}` } },
      { type: 'input_audio', input_audio: { data: Buffer.from('audio-zero').toString('base64'), format: 'wav' } },
    ],
  }]);
  assert.deepEqual(result.media, [{
    id: 'youtube-1',
    kind: 'video',
    durationSec: 90,
    windows: 1,
    framesUsed: 2,
    digested: false,
  }]);
  assert.deepEqual(result.warnings, []);
});
