// Llama Manager — pure editable chat artifact helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Detects substantial code and Markdown outputs, manages immutable version
// histories, and assembles/parses complete-file agent edit exchanges.

const CODE_LINE_THRESHOLD = 15;
const MARKDOWN_LINE_THRESHOLD = 40;

const LANGUAGE_EXTENSIONS = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  markdown: 'md',
  md: 'md',
  php: 'php',
  plaintext: 'txt',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  shell: 'sh',
  sql: 'sql',
  swift: 'swift',
  text: 'txt',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yml',
};

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function countLines(value) {
  const text = normalizeText(value);
  return text ? text.split('\n').length : 0;
}

function firstHeading(value) {
  return normalizeText(value).match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() || '';
}

function unquote(value) {
  const text = String(value || '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseHint(info, content) {
  const result = { filenameHint: '', titleHint: '' };
  const expression = /\b(filename|file|path|title)\s*=\s*("[^"]*"|'[^']*'|[^\s,]+)/gi;
  let match;
  while ((match = expression.exec(info)) !== null) {
    const key = match[1].toLowerCase();
    const value = unquote(match[2]);
    if (key === 'title') result.titleHint ||= value;
    else result.filenameHint ||= value;
  }

  const bareFilename = info.split(/\s+/).find((token, index) => (
    index > 0
    && !token.includes('=')
    && /(?:^|[/\\])?[\w.-]+\.[a-z0-9]{1,8}$/i.test(token)
  ));
  if (!result.filenameHint && bareFilename) result.filenameHint = unquote(bareFilename);

  const firstLine = normalizeText(content).split('\n')[0] || '';
  const commentHint = firstLine.match(
    /^\s*(?:(?:\/\/|#|<!--)\s*)?(filename|file|path|title)\s*:\s*(.+?)(?:\s*-->)?\s*$/i,
  );
  if (commentHint) {
    if (commentHint[1].toLowerCase() === 'title') {
      result.titleHint ||= unquote(commentHint[2]);
    } else {
      result.filenameHint ||= unquote(commentHint[2]);
    }
  }
  return result;
}

function parseFenceInfo(info) {
  const trimmed = String(info || '').trim();
  const first = trimmed.split(/\s+/)[0] || '';
  return first && !first.includes('=') ? first.toLowerCase() : 'text';
}

/**
 * Infer a compact artifact title using stable, user-meaningful precedence.
 */
function inferArtifactTitle({
  filenameHint = '',
  titleHint = '',
  message = '',
  content = '',
  language = '',
} = {}) {
  return String(filenameHint).trim()
    || String(titleHint).trim()
    || firstHeading(message)
    || firstHeading(content)
    || `${String(language || 'text').toLowerCase()} snippet`;
}

/**
 * Extract qualifying artifacts while leaving short code fences untouched.
 *
 * @returns {{artifacts: Array<object>, displayContent: string}}
 */
function extractArtifacts(value) {
  const message = normalizeText(value);
  const artifacts = [];
  const ranges = [];
  const fenceExpression = /^```([^\n]*)\n([\s\S]*?)^```\s*$/gm;
  let hasFence = false;
  let match;

  while ((match = fenceExpression.exec(message)) !== null) {
    hasFence = true;
    const info = match[1].trim();
    const content = match[2].replace(/\n$/, '');
    const hints = parseHint(info, content);
    const lineCount = countLines(content);
    if (lineCount < CODE_LINE_THRESHOLD && !hints.filenameHint && !hints.titleHint) continue;

    const language = parseFenceInfo(info);
    artifacts.push({
      content,
      language,
      lineCount,
      title: inferArtifactTitle({
        ...hints,
        message,
        content,
        language,
      }),
    });
    ranges.push([match.index, match.index + match[0].length]);
  }

  if (!hasFence && countLines(message) >= MARKDOWN_LINE_THRESHOLD) {
    artifacts.push({
      content: message,
      language: 'markdown',
      lineCount: countLines(message),
      title: inferArtifactTitle({ message, content: message, language: 'markdown' }),
    });
    return { artifacts, displayContent: '' };
  }

  if (ranges.length === 0) return { artifacts, displayContent: message };
  let cursor = 0;
  let displayContent = '';
  ranges.forEach(([start, end]) => {
    displayContent += message.slice(cursor, start);
    cursor = end;
  });
  displayContent += message.slice(cursor);

  return {
    artifacts,
    displayContent: displayContent.replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Materialize one detected artifact with its initial immutable version.
 */
function createArtifact(candidate, { createdAt = new Date().toISOString() } = {}) {
  const content = normalizeText(candidate.content);
  return {
    id: candidate.id,
    title: candidate.title || inferArtifactTitle(candidate),
    language: candidate.language || 'text',
    versionIndex: 0,
    versions: [{
      content,
      createdAt,
      source: candidate.source || 'agent',
    }],
  };
}

function getArtifactVersion(artifact) {
  const versions = Array.isArray(artifact?.versions) ? artifact.versions : [];
  const index = Math.min(
    Math.max(Number(artifact?.versionIndex) || 0, 0),
    Math.max(versions.length - 1, 0),
  );
  return versions[index] || { content: '', createdAt: '', source: '' };
}

/**
 * Append content as a new version without truncating or mutating history.
 */
function pushArtifactVersion(
  artifact,
  content,
  { source = 'user', createdAt = new Date().toISOString() } = {},
) {
  const versions = [
    ...(Array.isArray(artifact.versions) ? artifact.versions : []),
    { content: normalizeText(content), source, createdAt },
  ];
  return { ...artifact, versions, versionIndex: versions.length - 1 };
}

/**
 * Move through history with clamped bounds and no history mutation.
 */
function moveArtifactVersion(artifact, delta) {
  const lastIndex = Math.max((artifact.versions?.length || 1) - 1, 0);
  const nextIndex = Math.min(
    Math.max((Number(artifact.versionIndex) || 0) + Number(delta || 0), 0),
    lastIndex,
  );
  return { ...artifact, versionIndex: nextIndex };
}

/**
 * Append an ephemeral system instruction containing the selected file version.
 */
function assembleArtifactEditMessages(messages, artifact) {
  const current = getArtifactVersion(artifact).content;
  const language = artifact.language || 'text';
  const instruction = [
    `You are editing the artifact "${artifact.title || `${language} snippet`}".`,
    'Apply the user request to the current artifact content below.',
    'Return exactly one short, one-line summary followed by the COMPLETE updated file',
    'in a single fenced code block. Do not return patches, partial excerpts, or a second fence.',
    '',
    `Current artifact language: ${language}`,
    '--- BEGIN CURRENT ARTIFACT ---',
    current,
    '--- END CURRENT ARTIFACT ---',
  ].join('\n');
  return [
    ...messages.map((message) => ({ ...message })),
    { role: 'system', content: instruction },
  ];
}

/**
 * Parse the first complete fenced block from an agent artifact-edit response.
 */
function parseArtifactEditResponse(value) {
  const response = normalizeText(value);
  const opening = response.match(/(^|\n)(`{3,})([^\n]*)\n/);
  if (!opening) return null;

  const fence = opening[2];
  const contentStart = opening.index + opening[0].length;
  const closingExpression = new RegExp(`^${fence}\\s*$`, 'm');
  const tail = response.slice(contentStart);
  const closing = closingExpression.exec(tail);
  if (!closing) return null;

  const summaryLine = response
    .slice(0, opening.index)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(?:[-*]\s+|#{1,6}\s+)/, '') || '';
  const language = opening[3].trim().split(/\s+/)[0] || '';
  const content = tail.slice(0, closing.index).replace(/\n$/, '');
  return { summary: summaryLine, language, content };
}

function extensionForLanguage(language) {
  return LANGUAGE_EXTENSIONS[String(language || '').toLowerCase()] || 'txt';
}

export {
  CODE_LINE_THRESHOLD,
  MARKDOWN_LINE_THRESHOLD,
  assembleArtifactEditMessages,
  countLines,
  createArtifact,
  extensionForLanguage,
  extractArtifacts,
  getArtifactVersion,
  inferArtifactTitle,
  moveArtifactVersion,
  parseArtifactEditResponse,
  pushArtifactVersion,
};
