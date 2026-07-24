// Llama Manager — multimodal chat attachment contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies URL and paste classification plus the exact OpenAI-compatible
// content-part ordering used for images, long text, and sampled video frames.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LONG_TEXT_THRESHOLD,
  buildMessageContent,
  classifyPaste,
  classifyUrl,
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
