// Llama Manager — behavioral tests for server-side multimodal content expansion.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests exercise the public expandMessages interface with injected media
// and completion dependencies, verifying OpenAI-standard parts remain unchanged
// while URL-based audio and video extensions become standard content parts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('direct video_url honours range, max_frames, and include_audio false', async () => {
  const loaded = [];
  const result = await expandMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'Focus on the middle.' },
      {
        type: 'video_url',
        video_url: {
          url: 'https://cdn.example.test/demo.mp4',
          start: 30,
          end: 90,
          max_frames: 2,
          include_audio: false,
        },
      },
    ],
  }], {
    cache: new Map(),
    ingest: async (url, options) => {
      assert.equal(url, 'https://cdn.example.test/demo.mp4');
      assert.deepEqual(options, { sourceKind: 'direct' });
      return {
        id: 'direct-1',
        kind: 'video',
        filename: 'demo.mp4',
        durationSec: 120,
        frames: ['/frame/0', '/frame/1', '/frame/2', '/frame/3'],
        audio: { segments: ['/audio/0'] },
      };
    },
    loadArtifact: async path => {
      loaded.push(path);
      return Buffer.from(path);
    },
  });

  assert.deepEqual(loaded, ['/frame/1', '/frame/2']);
  assert.deepEqual(result.messages[0].content.map(part => (
    part.type === 'image_url' ? part.image_url.url : part.text || part.type
  )), [
    'Focus on the middle.',
    '[video: demo.mp4, duration 02:00]',
    '[frame 1/2 @ 00:48]',
    `data:image/jpeg;base64,${Buffer.from('/frame/1').toString('base64')}`,
    '[frame 2/2 @ 01:12]',
    `data:image/jpeg;base64,${Buffer.from('/frame/2').toString('base64')}`,
  ]);
  assert.deepEqual(result.media, [{
    id: 'direct-1', kind: 'video', durationSec: 120,
    windows: 1, framesUsed: 2, digested: false,
  }]);
  assert.deepEqual(result.warnings, []);
});

test('audio_url expands to standard input_audio content', async () => {
  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example.test/interview.mp3' },
    }],
  }], {
    cache: new Map(),
    ingest: async (url, options) => {
      assert.equal(url, 'https://cdn.example.test/interview.mp3');
      assert.deepEqual(options, { sourceKind: 'direct' });
      return {
        id: 'audio-1',
        kind: 'audio',
        filename: 'interview.mp3',
        durationSec: 45,
        frames: [],
        audio: { segments: ['/api/media/audio-1/audio/0.wav'] },
      };
    },
    loadArtifact: async path => {
      assert.equal(path, '/api/media/audio-1/audio/0.wav');
      return Buffer.from('normalized-audio');
    },
  });

  assert.deepEqual(result, {
    messages: [{
      role: 'user',
      content: [{
        type: 'input_audio',
        input_audio: {
          data: Buffer.from('normalized-audio').toString('base64'),
          format: 'wav',
        },
      }],
    }],
    media: [{
      id: 'audio-1', kind: 'audio', durationSec: 45,
      windows: 1, framesUsed: 0, digested: false,
    }],
    warnings: [],
  });
});

test('audio_url range selects intersecting segment and warns about approximate boundaries', async () => {
  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'audio_url',
      audio_url: {
        url: 'https://cdn.example.test/long.wav',
        start: 10,
        end: 20,
      },
    }],
  }], {
    cache: new Map(),
    ingest: async () => ({
      id: 'audio-range',
      kind: 'audio',
      filename: 'long.wav',
      durationSec: 120,
      frames: [],
      audio: { segments: ['/audio/window-0.wav'] },
    }),
    loadArtifact: async () => Buffer.from('window-audio'),
  });

  assert.equal(result.messages[0].content[0].type, 'input_audio');
  assert.deepEqual(result.warnings, [
    'audio_url https://cdn.example.test/long.wav requested 00:10-00:20; normalized audio uses intersecting stored window boundaries',
  ]);
});

test('failed extension expansion preserves the original part with a warning', async () => {
  const part = {
    type: 'video_url',
    video_url: { url: 'https://cdn.example.test/unavailable.mp4' },
  };
  const messages = [{ role: 'user', content: [part] }];

  const result = await expandMessages(messages, {
    cache: new Map(),
    ingest: async () => { throw new Error('download failed'); },
  });

  assert.strictEqual(result.messages[0].content[0], part);
  assert.deepEqual(result.media, []);
  assert.deepEqual(result.warnings, [
    'video_url https://cdn.example.test/unavailable.mp4 was not expanded: download failed',
  ]);
});

test('video longer than one window is digested per window with representative frames', async () => {
  const completions = [];
  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'video_url',
      video_url: {
        url: 'https://cdn.example.test/lecture.mp4',
        max_frames: 2,
      },
    }],
  }], {
    model: 'gemma-4',
    cache: new Map(),
    ingest: async () => ({
      id: 'long-video',
      kind: 'video',
      filename: 'lecture.mp4',
      durationSec: 1_200,
      frames: ['/frame/0', '/frame/1', '/frame/2', '/frame/3'],
      audio: { segments: ['/audio/0', '/audio/1'] },
    }),
    loadArtifact: async path => Buffer.from(path),
    complete: async request => {
      completions.push(request);
      return {
        choices: [{ message: { content: `digest window ${completions.length}` } }],
      };
    },
  });

  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map(call => call.model), ['gemma-4', 'gemma-4']);
  assert.deepEqual(completions.map(call => call.messages[1].content.map(part => part.type)), [
    ['text', 'image_url', 'image_url', 'input_audio'],
    ['text', 'image_url', 'image_url', 'input_audio'],
  ]);
  assert.equal(result.messages[0].content[0].text,
    '[media digest: lecture.mp4]\n[00:00-10:00] digest window 1\n[10:00-20:00] digest window 2');
  assert.deepEqual(result.messages[0].content.slice(1).map(part => (
    part.type === 'image_url' ? part.image_url.url : part.text
  )), [
    '[frame 1/2 @ 06:40]',
    `data:image/jpeg;base64,${Buffer.from('/frame/1').toString('base64')}`,
    '[frame 2/2 @ 16:40]',
    `data:image/jpeg;base64,${Buffer.from('/frame/3').toString('base64')}`,
  ]);
  assert.deepEqual(result.media, [{
    id: 'long-video', kind: 'video', durationSec: 1_200,
    windows: 2, framesUsed: 2, digested: true,
  }]);
  assert.deepEqual(result.warnings, []);
});

test('video range loads only intersecting audio and warns when boundaries are approximate', async () => {
  const loaded = [];
  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'video_url',
      video_url: {
        url: 'https://cdn.example.test/ranged.mp4',
        start: 650,
        end: 700,
      },
    }],
  }], {
    cache: new Map(),
    ingest: async () => ({
      id: 'ranged-video', kind: 'video', filename: 'ranged.mp4', durationSec: 1_200,
      frames: [], audio: { segments: ['/audio/0', '/audio/1'] },
    }),
    loadArtifact: async path => { loaded.push(path); return Buffer.from(path); },
  });

  assert.deepEqual(loaded, ['/audio/1']);
  assert.deepEqual(result.warnings, [
    'video_url https://cdn.example.test/ranged.mp4 requested 10:50-11:40; normalized audio uses intersecting stored window boundaries',
  ]);
});

test('invalid media URL is preserved and never sent to ingestion', async () => {
  const part = { type: 'audio_url', audio_url: { url: 'file:///tmp/private.wav' } };
  const result = await expandMessages([{ role: 'user', content: [part] }], {
    cache: new Map(),
    ingest: async () => assert.fail('invalid URLs must not be ingested'),
  });

  assert.strictEqual(result.messages[0].content[0], part);
  assert.deepEqual(result.warnings, [
    'audio_url file:///tmp/private.wav was not expanded: url must use http or https',
  ]);
});

test('repeated URL in a conversation reuses one ingestion result', async () => {
  let ingestions = 0;
  const part = {
    type: 'audio_url',
    audio_url: { url: 'https://cdn.example.test/repeated.wav' },
  };
  const result = await expandMessages([
    { role: 'user', content: [part] },
    { role: 'user', content: [part] },
  ], {
    cache: new Map(),
    ingest: async () => {
      ingestions += 1;
      return {
        id: 'cached-audio', kind: 'audio', durationSec: 5,
        frames: [], audio: { segments: ['/audio/0'] },
      };
    },
    loadArtifact: async () => Buffer.from('audio'),
  });

  assert.equal(ingestions, 1);
  assert.equal(result.media.length, 2);
});

test('cache lifetime is per call unless a shared cache is explicitly provided', async () => {
  let ingestions = 0;
  const messages = [{
    role: 'user',
    content: [{
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example.test/per-request.wav' },
    }],
  }];
  const options = {
    ingest: async () => {
      ingestions += 1;
      return {
        id: 'cache-lifetime', kind: 'audio', durationSec: 5, frames: [],
        audio: { segments: ['/audio/0'] },
      };
    },
    loadArtifact: async () => Buffer.from('audio'),
  };

  await expandMessages(messages, options);
  await expandMessages(messages, options);

  assert.equal(ingestions, 2);
  const cache = new Map();
  await expandMessages(messages, { ...options, cache });
  await expandMessages(messages, { ...options, cache });

  assert.equal(ingestions, 3);
});

test('default dependencies ingest and load raw artifacts through the media API', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'http://127.0.0.1:9999/api/media/link') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { url: 'https://cdn.example.test/default.wav' });
      return new Response(JSON.stringify({
        id: 'default-audio', kind: 'audio', durationSec: 3, frames: [],
        audio: { segments: ['/api/media/default-audio/audio/0.wav'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'http://127.0.0.1:9999/api/media/default-audio/audio/0.wav') {
      return new Response(Buffer.from('raw-wav-bytes'), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };

  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example.test/default.wav' },
    }],
  }], {
    baseUrl: 'http://127.0.0.1:9999',
    fetchImpl,
    cache: new Map(),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(result.messages[0].content[0], {
    type: 'input_audio',
    input_audio: {
      data: Buffer.from('raw-wav-bytes').toString('base64'),
      format: 'wav',
    },
  });
});

test('audio longer than one window is digested per window', async () => {
  const completions = [];
  const result = await expandMessages([{
    role: 'user',
    content: [{
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example.test/long-audio.wav' },
    }],
  }], {
    model: 'gemma-4',
    cache: new Map(),
    ingest: async () => ({
      id: 'long-audio', kind: 'audio', filename: 'long-audio.wav', durationSec: 1_200,
      frames: [], audio: { segments: ['/audio/0', '/audio/1'] },
    }),
    loadArtifact: async path => Buffer.from(path),
    complete: async request => {
      completions.push(request);
      return `audio digest ${completions.length}`;
    },
  });

  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map(call => call.messages[1].content.map(part => part.type)), [
    ['text', 'input_audio'],
    ['text', 'input_audio'],
  ]);
  assert.deepEqual(result.messages[0].content, [{
    type: 'text',
    text: '[media digest: long-audio.wav]\n[00:00-10:00] audio digest 1\n[10:00-20:00] audio digest 2',
  }]);
  assert.deepEqual(result.media, [{
    id: 'long-audio', kind: 'audio', durationSec: 1_200,
    windows: 2, framesUsed: 0, digested: true,
  }]);
});

test('bare v1 aliases register the same named handlers before the SPA catch-all', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const registrations = [
    ['get', 'models', 'handleModels'],
    ['get', 'models/:model', 'handleModel'],
    ['post', 'chat/completions', 'handleChatCompletions'],
    ['post', 'completions', 'handleCompletions'],
    ['post', 'embeddings', 'handleEmbeddings'],
    ['post', 'responses', 'handleResponses'],
    ['post', 'messages', 'handleMessages'],
    ['post', 'messages/count_tokens', 'handleMessageTokenCount'],
    ['post', 'rerank', 'handleRerank'],
    ['post', 'reranking', 'handleReranking'],
  ];
  const catchAllIndex = source.indexOf("app.get('*'");

  for (const [method, path, handler] of registrations) {
    const apiRegistration = `app.${method}('/api/v1/${path}', ${handler});`;
    const bareRegistration = `app.${method}('/v1/${path}', ${handler});`;
    assert.ok(source.includes(apiRegistration), apiRegistration);
    assert.ok(source.includes(bareRegistration), bareRegistration);
    assert.ok(source.indexOf(bareRegistration) < catchAllIndex, `${bareRegistration} must precede SPA fallback`);
  }

  const chatHandler = source.slice(
    source.indexOf('async function handleChatCompletions'),
    source.indexOf("app.post('/api/v1/chat/completions'"),
  );
  assert.match(chatHandler, /const isStreaming = req\.body\.stream === true/);
  assert.equal((chatHandler.match(/expandMessages\(/g) || []).length, 1);
  assert.match(chatHandler, /res\.setHeader\('x-llama-manager-media', JSON\.stringify\(mediaMetadata\)\)/);

  const responsesHandler = source.slice(
    source.indexOf('async function handleResponses'),
    source.indexOf("app.post('/api/v1/responses'"),
  );
  assert.match(responsesHandler, /resolveRequestModel\(rawModel\)/);
  assert.match(responsesHandler, /ensureDs4ForModel\(rawModel, requestedModel,/);
  assert.match(responsesHandler, /readRelayState\(req\.headers\)/);
  assert.match(responsesHandler, /requestPriority: requestPolicy\.priority/);
  assert.match(responsesHandler, /ds4RequestTarget\(/);
  assert.match(responsesHandler, /proxy: proxyResponsesToDs4/);

  const responsesDs4Proxy = source.slice(
    source.indexOf('async function proxyResponsesToDs4'),
    source.indexOf('async function handleResponses'),
  );
  assert.match(responsesDs4Proxy, /ds4TargetUrl\(ds4\.port, '\/v1\/responses'\)/);
  assert.match(responsesDs4Proxy, /startActiveRequest\([^)]*endpoint: 'responses'[^)]*backend: 'ds4'/s);
  assert.match(responsesDs4Proxy, /endActiveRequest\(activeReqId/);
});

test('audio without normalized artifacts preserves the original part', async () => {
  const part = {
    type: 'audio_url',
    audio_url: { url: 'https://cdn.example.test/silent.wav' },
  };
  const result = await expandMessages([{ role: 'user', content: [part] }], {
    cache: new Map(),
    ingest: async () => ({
      id: 'missing-audio', kind: 'audio', durationSec: 10, frames: [],
    }),
  });

  assert.strictEqual(result.messages[0].content[0], part);
  assert.deepEqual(result.warnings, [
    'audio_url https://cdn.example.test/silent.wav was not expanded: ingested media has no normalized audio artifacts',
  ]);
});

test('empty media range preserves the original part instead of dropping content', async () => {
  const part = {
    type: 'video_url',
    video_url: {
      url: 'https://cdn.example.test/range.mp4',
      start: 90,
      end: 10,
      include_audio: false,
    },
  };
  const result = await expandMessages([{ role: 'user', content: [part] }], {
    cache: new Map(),
    ingest: async () => ({
      id: 'bad-range', kind: 'video', filename: 'range.mp4', durationSec: 100,
      frames: ['/frame/0'],
    }),
  });

  assert.strictEqual(result.messages[0].content[0], part);
  assert.deepEqual(result.warnings, [
    'video_url https://cdn.example.test/range.mp4 was not expanded: media end must be greater than start',
  ]);
});
