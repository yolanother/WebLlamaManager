// Llama Manager — unit tests for automatic chat model routing and UI prompt injection.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_CHAT_PROMPT,
  VISION_MODEL_PATTERN,
  buildClassificationPrompt,
  filterRoutingCandidates,
  injectBaseChatPrompt,
  parseRouterChoice,
  routeAutoModel,
} from './chat-router.js';

const catalog = [
  { id: 'qwen-3b-fast' },
  { id: 'qwen-coder-32b' },
  { id: 'gemma-vision-27b' },
  { id: 'embedding-model', task: 'embedding' },
];

function textBody(text, extra = {}) {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: text }],
    ...extra,
  };
}

test('VISION_MODEL_PATTERN documents the built-in vision-name heuristic', () => {
  assert.match('qwen2.5-vl-7b', VISION_MODEL_PATTERN);
  assert.match('LLaVA-13B', VISION_MODEL_PATTERN);
  assert.match('gemma-27b', VISION_MODEL_PATTERN);
  assert.doesNotMatch('qwen-coder-32b', VISION_MODEL_PATTERN);
});

test('buildClassificationPrompt includes truncated last-user text, attachments, and capability hints', () => {
  const longText = `start-${'x'.repeat(2200)}-end`;
  const body = {
    messages: [
      { role: 'user', content: 'older request' },
      {
        role: 'user',
        content: [
          { type: 'text', text: longText },
          { type: 'video_url', video_url: { url: 'https://example.test/clip.mp4' } },
        ],
      },
    ],
  };
  const messages = buildClassificationPrompt(body, catalog);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /single JSON object/i);
  assert.match(messages[1].content, /Attachments: image=no, video=yes/);
  assert.match(messages[1].content, /qwen-3b-fast \[small\/fast\]/);
  assert.match(messages[1].content, /qwen-coder-32b \[coder, big\/general\]/);
  assert.match(messages[1].content, /gemma-vision-27b \[vision-capable, big\/general\]/);
  assert.doesNotMatch(messages[1].content, /embedding-model/);
  assert.match(messages[1].content, /start-/);
  assert.doesNotMatch(messages[1].content, /-end/);
  const requestSection = messages[1].content.split('Last user request:\n')[1];
  assert.equal(requestSection.length, 2000);
});

test('filterRoutingCandidates excludes non-chat models and restricts image requests to vision models', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    }],
  };
  assert.deepEqual(
    filterRoutingCandidates(body, catalog).map(model => model.id),
    ['gemma-vision-27b'],
  );
});

test('filterRoutingCandidates accepts operator-configured vision model ids', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Read the image.' },
        { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
      ],
    }],
  };
  assert.deepEqual(
    filterRoutingCandidates(body, catalog, { routerVisionModels: ['qwen-coder-32b'] })
      .map(model => model.id),
    ['qwen-coder-32b', 'gemma-vision-27b'],
  );
});

test('parseRouterChoice validates a JSON model id against real candidates', () => {
  const candidates = filterRoutingCandidates(textBody('Write code'), catalog);
  assert.equal(
    parseRouterChoice({ choices: [{ message: { content: '{"model":"qwen-coder-32b"}' } }] }, candidates),
    'qwen-coder-32b',
  );
  assert.equal(parseRouterChoice('{"model":"not-installed"}', candidates), null);
  assert.equal(parseRouterChoice('model=qwen-coder-32b', candidates), null);
  assert.equal(parseRouterChoice('{"model":42}', candidates), null);
});

test('routeAutoModel classifies with default-small and rewrites the request model', async () => {
  const body = textBody('Implement a JavaScript parser with tests.');
  let completionCall;
  const choice = await routeAutoModel(body, {
    listModels: async () => ({ object: 'list', data: catalog }),
    complete: async (model, messages, opts) => {
      completionCall = { model, messages, opts };
      return { choices: [{ message: { content: '{"model":"qwen-coder-32b"}' } }] };
    },
  });
  assert.equal(choice, 'qwen-coder-32b');
  assert.equal(body.model, 'qwen-coder-32b');
  assert.equal(completionCall.model, 'default-small');
  assert.equal(completionCall.opts.stream, false);
  assert.equal(completionCall.opts.temperature, 0);
  assert.equal(completionCall.opts.max_tokens, 64);
});

test('routeAutoModel sends only vision-capable candidates for image requests', async () => {
  const body = {
    model: 'default-router',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    }],
  };
  let classifierPrompt = '';
  const choice = await routeAutoModel(body, {
    listModels: async () => catalog,
    complete: async (_model, messages) => {
      classifierPrompt = messages[1].content;
      return '{"model":"gemma-vision-27b"}';
    },
  });
  assert.equal(choice, 'gemma-vision-27b');
  assert.match(classifierPrompt, /gemma-vision-27b/);
  assert.doesNotMatch(classifierPrompt, /qwen-coder-32b/);
});

test('routeAutoModel falls back to default-small for a short text request', async () => {
  const body = textBody('Hi');
  const choice = await routeAutoModel(body, {
    listModels: async () => catalog,
    complete: async () => { throw new Error('classifier unavailable'); },
  });
  assert.equal(choice, 'default-small');
  assert.equal(body.model, 'default-small');
});

test('routeAutoModel falls back to default-big for long text, attachments, bad JSON, and timeout', async (t) => {
  await t.test('long text', async () => {
    const body = textBody('x'.repeat(200));
    const choice = await routeAutoModel(body, {
      listModels: async () => catalog,
      complete: async () => 'not json',
    });
    assert.equal(choice, 'default-big');
    assert.equal(body.model, 'default-big');
  });

  await t.test('attachment', async () => {
    const body = {
      model: 'auto',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
      }],
    };
    const choice = await routeAutoModel(body, {
      listModels: async () => catalog,
      complete: async () => '{"model":"unknown"}',
    });
    assert.equal(choice, 'default-big');
  });

  await t.test('timeout', async () => {
    const body = textBody('A long task: ' + 'x'.repeat(250));
    const choice = await routeAutoModel(body, {
      listModels: async () => catalog,
      complete: async () => new Promise(() => {}),
      timeoutMs: 5,
    });
    assert.equal(choice, 'default-big');
  });
});

test('injectBaseChatPrompt prepends the exported prompt for metadata-flagged UI traffic', () => {
  const body = {
    metadata: { llama_manager_chat: true },
    messages: [{ role: 'user', content: 'Hello' }],
  };
  assert.equal(injectBaseChatPrompt(body, {}), true);
  assert.deepEqual(body.messages[0], { role: 'system', content: BASE_CHAT_PROMPT });
  assert.match(BASE_CHAT_PROMPT, /local models/i);
  assert.match(BASE_CHAT_PROMPT, /YouTube/i);
  assert.match(BASE_CHAT_PROMPT, /yt-dlp/i);
  assert.match(BASE_CHAT_PROMPT, /MM:SS/);
  assert.match(BASE_CHAT_PROMPT, /\[frame 3\/16 @ 01:15\]/);
});

test('injectBaseChatPrompt accepts the UI header and does not duplicate an existing system message', () => {
  const headerBody = { messages: [{ role: 'user', content: 'Hello' }] };
  assert.equal(injectBaseChatPrompt(headerBody, { 'x-llama-manager-chat': '1' }), true);
  assert.equal(headerBody.messages[0].role, 'system');

  const existing = {
    metadata: { llama_manager_chat: true },
    messages: [
      { role: 'system', content: 'Caller prompt' },
      { role: 'user', content: 'Hello' },
    ],
  };
  assert.equal(injectBaseChatPrompt(existing, {}), false);
  assert.equal(existing.messages.length, 2);
  assert.equal(existing.messages[0].content, 'Caller prompt');
});

test('injectBaseChatPrompt never changes unflagged OpenAI-compatible traffic', () => {
  const body = { messages: [{ role: 'user', content: 'Hello' }] };
  assert.equal(injectBaseChatPrompt(body, {}), false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
});
