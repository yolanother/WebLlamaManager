// Llama Manager — editable chat artifact contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies artifact thresholds, title inference, immutable version history,
// agent-edit request envelopes, and complete-file response parsing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleArtifactEditMessages,
  createArtifact,
  extractArtifacts,
  inferArtifactTitle,
  moveArtifactVersion,
  parseArtifactEditResponse,
  pushArtifactVersion,
} from './artifacts.js';

function lines(count, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

test('fenced code becomes an artifact at the 15-line boundary', () => {
  const short = extractArtifacts(`Before\n\n\`\`\`js\n${lines(14)}\n\`\`\`\n\nAfter`);
  assert.equal(short.artifacts.length, 0);
  assert.match(short.displayContent, /```js/);

  const boundary = extractArtifacts(`Before\n\n\`\`\`js\n${lines(15)}\n\`\`\`\n\nAfter`);
  assert.equal(boundary.artifacts.length, 1);
  assert.equal(boundary.artifacts[0].language, 'js');
  assert.equal(boundary.artifacts[0].lineCount, 15);
  assert.equal(boundary.artifacts[0].content, lines(15));
  assert.equal(boundary.displayContent, 'Before\n\nAfter');
});

test('a filename or title hint promotes a short fenced block', () => {
  const filename = extractArtifacts('```ts filename="chat.ts"\nexport const chat = true;\n```');
  assert.equal(filename.artifacts.length, 1);
  assert.equal(filename.artifacts[0].title, 'chat.ts');

  const title = extractArtifacts('```python title="Router health check"\nprint("ok")\n```');
  assert.equal(title.artifacts.length, 1);
  assert.equal(title.artifacts[0].title, 'Router health check');
});

test('whole-message markdown becomes an artifact at the 40-line boundary', () => {
  const short = extractArtifacts(`# Release notes\n${lines(38)}`);
  assert.equal(short.artifacts.length, 0);

  const boundary = extractArtifacts(`# Release notes\n${lines(39)}`);
  assert.equal(boundary.artifacts.length, 1);
  assert.equal(boundary.artifacts[0].language, 'markdown');
  assert.equal(boundary.artifacts[0].lineCount, 40);
  assert.equal(boundary.artifacts[0].title, 'Release notes');
  assert.equal(boundary.displayContent, '');
});

test('title inference prefers filename, then heading, then language', () => {
  assert.equal(inferArtifactTitle({
    filenameHint: 'src/router.js',
    titleHint: 'Ignored title',
    message: '# Ignored heading',
    language: 'javascript',
  }), 'src/router.js');
  assert.equal(inferArtifactTitle({
    message: 'Intro\n\n## Deployment checklist\nDetails',
    language: 'markdown',
  }), 'Deployment checklist');
  assert.equal(inferArtifactTitle({ language: 'typescript' }), 'typescript snippet');
  assert.equal(inferArtifactTitle({}), 'text snippet');
});

test('version pushes and navigation never mutate existing history', () => {
  const original = createArtifact({
    id: 'artifact-1',
    title: 'app.js',
    language: 'js',
    content: 'const version = 1;',
  }, { createdAt: '2026-01-01T00:00:00.000Z' });
  const second = pushArtifactVersion(original, 'const version = 2;', {
    source: 'user',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const rewound = moveArtifactVersion(second, -1);
  const branched = pushArtifactVersion(rewound, 'const version = 3;', {
    source: 'agent',
    createdAt: '2026-01-03T00:00:00.000Z',
  });

  assert.equal(original.versions.length, 1);
  assert.equal(second.versions.length, 2);
  assert.equal(rewound.versionIndex, 0);
  assert.equal(branched.versionIndex, 2);
  assert.deepEqual(branched.versions.map((version) => version.content), [
    'const version = 1;',
    'const version = 2;',
    'const version = 3;',
  ]);
  assert.equal(moveArtifactVersion(branched, -99).versionIndex, 0);
  assert.equal(moveArtifactVersion(branched, 99).versionIndex, 2);
});

test('agent-edit envelope includes the selected version and complete-file rules', () => {
  const artifact = {
    id: 'artifact-1',
    title: 'app.js',
    language: 'javascript',
    versionIndex: 0,
    versions: [
      { content: 'const selected = true;' },
      { content: 'const selected = false;' },
    ],
  };
  const messages = [{ role: 'user', content: 'Add validation.' }];
  const assembled = assembleArtifactEditMessages(messages, artifact);

  assert.equal(assembled.length, 2);
  assert.deepEqual(assembled[0], messages[0]);
  assert.equal(assembled[1].role, 'system');
  assert.match(assembled[1].content, /app\.js/);
  assert.match(assembled[1].content, /COMPLETE updated file/i);
  assert.match(assembled[1].content, /single fenced code block/i);
  assert.match(assembled[1].content, /const selected = true;/);
  assert.doesNotMatch(assembled[1].content, /const selected = false;/);
  assert.deepEqual(messages, [{ role: 'user', content: 'Add validation.' }]);
});

test('agent-edit response parsing returns the first fence and preceding summary', () => {
  const parsed = parseArtifactEditResponse([
    'Added validation and kept the public API stable.',
    '',
    '```js',
    'export const valid = true;',
    '```',
    '',
    '```txt',
    'ignore this second fence',
    '```',
  ].join('\n'));

  assert.deepEqual(parsed, {
    summary: 'Added validation and kept the public API stable.',
    language: 'js',
    content: 'export const valid = true;',
  });
  assert.equal(parseArtifactEditResponse('I could not update the file.'), null);
});
