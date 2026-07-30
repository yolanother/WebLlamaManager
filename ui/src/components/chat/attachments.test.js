// Llama Manager — multimodal chat attachment contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies media-file and paste classification, exact OpenAI-compatible
// content-part ordering, server-ingest mapping, and rendered audio attachment
// controls for the chat composer.

import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';

import {
  LONG_TEXT_THRESHOLD,
  buildMessageContent,
  buildReadyMediaAttachment,
  classifyPaste,
  classifyUrl,
  partitionMediaFiles,
} from './attachments.js';

test('classifyUrl distinguishes YouTube, direct video, and unrelated URLs', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=15',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal(classifyUrl(url), 'youtube');
  }

  for (const url of [
    'https://cdn.example.com/demo.mp4',
    'https://cdn.example.com/camera.WEBM?download=1',
    'https://example.com/clips/sample.mov#preview',
  ]) {
    assert.equal(classifyUrl(url), 'video');
  }

  assert.equal(classifyUrl('https://example.com/article'), 'other');
  assert.equal(classifyUrl('not a URL'), 'other');
});

test('classifyPaste converts video links and text beyond 8,000 characters', () => {
  assert.deepEqual(
    classifyPaste('  https://youtu.be/dQw4w9WgXcQ  '),
    { type: 'attachment-url', kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' },
  );
  assert.deepEqual(
    classifyPaste('https://cdn.example.com/demo.mp4'),
    { type: 'attachment-url', kind: 'video', url: 'https://cdn.example.com/demo.mp4' },
  );

  const longText = 'a'.repeat(LONG_TEXT_THRESHOLD + 1);
  assert.deepEqual(classifyPaste(longText), {
    type: 'text-attachment',
    text: longText,
  });
  assert.deepEqual(classifyPaste('a'.repeat(LONG_TEXT_THRESHOLD)), {
    type: 'text',
    text: 'a'.repeat(LONG_TEXT_THRESHOLD),
  });
  assert.deepEqual(classifyPaste('Read https://example.com/demo.mp4 please'), {
    type: 'text',
    text: 'Read https://example.com/demo.mp4 please',
  });
});

test('partitionMediaFiles accepts audio alongside image and video files', () => {
  const image = { name: 'photo.png', type: 'image/png' };
  const audio = { name: 'meeting.wav', type: 'audio/wav' };
  const video = { name: 'demo.mp4', type: 'video/mp4' };
  const ignored = { name: 'notes.pdf', type: 'application/pdf' };

  assert.deepEqual(partitionMediaFiles([image, audio, video, ignored]), {
    audios: [audio],
    images: [image],
    videos: [video],
  });
});

test('buildReadyMediaAttachment maps server WAV segments onto an audio upload', () => {
  assert.deepEqual(buildReadyMediaAttachment({
    media: {
      id: 'media-1',
      kind: 'audio',
      filename: 'interview.mp3',
      mime: 'audio/mpeg',
      size: 2048,
      durationSec: 95,
      audio: {
        durationSec: 95,
        segments: [
          '/api/media/media-1/audio/0.wav',
          '/api/media/media-1/audio/1.wav',
        ],
      },
    },
    source: { type: 'audio-file', file: { name: 'fallback.mp3' } },
    segmentDataUrls: [
      'data:audio/wav;base64,U0VHTUVOVDE=',
      'data:audio/wav;base64,U0VHTUVOVDI=',
    ],
  }), {
    kind: 'audio',
    filename: 'interview.mp3',
    mediaId: 'media-1',
    mime: 'audio/mpeg',
    size: 2048,
    durationSec: 95,
    segments: [
      { dataUrl: 'data:audio/wav;base64,U0VHTUVOVDE=', format: 'wav' },
      { dataUrl: 'data:audio/wav;base64,U0VHTUVOVDI=', format: 'wav' },
    ],
    status: 'ready',
  });
});

test('video ingest appends normalized audio after its unchanged frame parts', () => {
  const attachment = buildReadyMediaAttachment({
    media: {
      id: 'video-1',
      kind: 'video',
      filename: 'demo.mp4',
      mime: 'video/mp4',
      size: 4096,
      durationSec: 75,
      audio: {
        durationSec: 75,
        segments: ['/api/media/video-1/audio/0.wav'],
      },
    },
    source: { type: 'video-file', file: { name: 'demo.mp4' } },
    frames: [{ dataUrl: 'data:image/jpeg;base64,FRAME' }],
    segmentDataUrls: ['data:audio/wav;base64,U09VTkQ='],
  });

  assert.deepEqual(buildMessageContent({
    text: 'Describe the clip.',
    attachments: [attachment],
  }), [
    { type: 'text', text: 'Describe the clip.' },
    { type: 'text', text: '[video: demo.mp4, duration 01:15]' },
    { type: 'text', text: '[frame 1/1 @ 00:00]' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FRAME' } },
    {
      type: 'input_audio',
      input_audio: { data: 'U09VTkQ=', format: 'wav' },
    },
  ]);
});

test('buildMessageContent assembles text, images, long text, and video frame pairs', () => {
  const content = buildMessageContent({
    text: 'Summarize these inputs.',
    attachments: [
      {
        kind: 'image',
        filename: 'whiteboard.png',
        dataUrl: 'data:image/png;base64,IMAGE',
      },
      {
        kind: 'text',
        filename: 'pasted-text.txt',
        text: 'alpha\nbeta',
      },
      {
        kind: 'video',
        filename: 'demo.mp4',
        durationSec: 75,
        frames: [
          { dataUrl: 'data:image/jpeg;base64,FRAME1' },
          { dataUrl: 'data:image/jpeg;base64,FRAME2' },
          { dataUrl: 'data:image/jpeg;base64,FRAME3' },
        ],
      },
    ],
  });

  assert.deepEqual(content, [
    { type: 'text', text: 'Summarize these inputs.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,IMAGE' },
    },
    {
      type: 'text',
      text: '[text attachment: pasted-text.txt]\n```text\nalpha\nbeta\n```',
    },
    { type: 'text', text: '[video: demo.mp4, duration 01:15]' },
    { type: 'text', text: '[frame 1/3 @ 00:00]' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,FRAME1' },
    },
    { type: 'text', text: '[frame 2/3 @ 00:25]' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,FRAME2' },
    },
    { type: 'text', text: '[frame 3/3 @ 00:50]' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,FRAME3' },
    },
  ]);
});

test('buildMessageContent keeps plain text messages as strings', () => {
  assert.equal(
    buildMessageContent({ text: 'Just text', attachments: [] }),
    'Just text',
  );
});

test('buildMessageContent emits WAV audio without a data URL prefix', () => {
  assert.deepEqual(buildMessageContent({
    attachments: [{
      kind: 'audio',
      filename: 'meeting.wav',
      durationSec: 65,
      segments: [{
        dataUrl: 'data:audio/wav;base64,V0FWREFUQQ==',
        format: 'wav',
      }],
    }],
  }), [
    { type: 'text', text: '[audio: meeting.wav, duration 01:05]' },
    {
      type: 'input_audio',
      input_audio: { data: 'V0FWREFUQQ==', format: 'wav' },
    },
  ]);
});

test('buildMessageContent infers MP3 format from its data URL', () => {
  assert.deepEqual(buildMessageContent({
    text: 'Transcribe this.',
    attachments: [{
      kind: 'audio',
      filename: 'interview.mp3',
      durationSec: 9,
      segments: [{ dataUrl: 'data:audio/mpeg;base64,TVAzREFUQQ==' }],
    }],
  }), [
    { type: 'text', text: 'Transcribe this.' },
    { type: 'text', text: '[audio: interview.mp3, duration 00:09]' },
    {
      type: 'input_audio',
      input_audio: { data: 'TVAzREFUQQ==', format: 'mp3' },
    },
  ]);
});

test('AttachmentChip renders audio duration plus retry and remove controls', async () => {
  const hmrServer = createHttpServer();
  const server = await createViteServer({
    appType: 'custom',
    server: { hmr: { server: hmrServer }, middlewareMode: true },
  });
  try {
    const { AttachmentChip } = await server.ssrLoadModule(
      '/src/components/chat/AttachmentChip.jsx',
    );
    const readyHtml = renderToStaticMarkup(createElement(AttachmentChip, {
      attachment: {
        id: 'audio-1',
        kind: 'audio',
        filename: 'meeting.wav',
        durationSec: 65,
        status: 'ready',
      },
      onRemove() {},
      onRetry() {},
    }));
    assert.match(readyHtml, /meeting\.wav/);
    assert.match(readyHtml, /01:05/);
    assert.match(readyHtml, /aria-label="Remove meeting\.wav"/);

    const errorHtml = renderToStaticMarkup(createElement(AttachmentChip, {
      attachment: {
        id: 'audio-2',
        kind: 'audio',
        filename: 'broken.mp3',
        status: 'error',
        error: 'Audio ingest failed.',
      },
      onRemove() {},
      onRetry() {},
    }));
    assert.match(errorHtml, /aria-label="Retry broken\.mp3"/);
    assert.match(errorHtml, /aria-label="Remove broken\.mp3"/);
  } finally {
    await server.close();
  }
});

test('Composer exposes an audio file picker', async () => {
  const hmrServer = createHttpServer();
  const server = await createViteServer({
    appType: 'custom',
    server: { hmr: { server: hmrServer }, middlewareMode: true },
  });
  try {
    const { Composer } = await server.ssrLoadModule('/src/components/chat/Composer.jsx');
    const html = renderToStaticMarkup(createElement(Composer, {
      attachments: [],
      disabled: false,
      isStreaming: false,
      models: [],
      onAudioFiles() {},
      onChange() {},
      onImageFiles() {},
      onModelChange() {},
      onRemoveAttachment() {},
      onRetryAttachment() {},
      onSubmit() {},
      onVideoFiles() {},
      value: '',
    }));
    assert.match(html, /aria-label="Attach audio"/);
    assert.match(html, /accept="audio\/\*"/);
    assert.match(html, /multiple=""/);
  } finally {
    await server.close();
  }
});
