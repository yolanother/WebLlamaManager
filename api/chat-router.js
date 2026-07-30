// Llama Manager — automatic chat model routing and chat-UI base prompt injection.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure helpers build and validate the small-model classification request, while
// routeAutoModel provides the single injectable async seam used by server.js.

/** Request-time model aliases that invoke the small-brain classifier. */
export const AUTO_MODEL_ALIASES = Object.freeze(['auto', 'default-router']);

/**
 * Built-in name heuristic for models that can accept image content parts.
 *
 * Operators can extend this heuristic with exact model ids in
 * `config.routerVisionModels`; keeping the regex exported makes the built-in
 * behavior visible to integrations and configuration tooling.
 */
export const VISION_MODEL_PATTERN = /vl|vision|llava|gemma|qwen.*vl|minicpm/i;

/**
 * Base system prompt for requests explicitly identified as Llama Manager chat-UI
 * traffic. The UI/server media contract represents sampled video as timestamp
 * text parts such as `[frame 3/16 @ 01:15]` alongside the corresponding
 * `image_url` content parts. External OpenAI-compatible traffic never receives
 * this prompt unless it opts into the documented UI metadata/header contract.
 */
export const BASE_CHAT_PROMPT = [
  "You are Llama Manager's assistant, running on local models.",
  'Users can attach images for you to inspect. They can also attach video files, paste direct video links, or paste YouTube links; Llama Manager ingests linked videos with yt-dlp and converts videos into sampled frames with timestamps.',
  'Video frame timestamp markers arrive as text content parts such as [frame 3/16 @ 01:15] alongside the corresponding image_url parts.',
  'When discussing a video, tie observations to the provided frame timestamps and reference relevant moments using MM:SS timestamps.',
  'Be concise, and be honest about uncertainty and capability limits.',
].join(' ');

const ROUTER_TIMEOUT_MS = 10_000;
const MAX_ROUTER_TEXT_CHARS = 2_000;

/**
 * Normalize OpenAI model-list data into unique chat-capable model records.
 *
 * @param {Array<string|object>|{data?: Array<string|object>}|null|undefined} models model catalog
 * @returns {Array<object>} normalized model records with non-empty ids
 */
function normalizeModels(models) {
  const source = Array.isArray(models) ? models : models?.data;
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of source) {
    const record = typeof item === 'string' ? { id: item } : item;
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    if (record.task === 'embedding' || record.status === 'embedding') continue;
    seen.add(id);
    normalized.push({ ...record, id });
  }
  return normalized;
}

/**
 * Read text from a message content value without serializing binary/image data.
 *
 * @param {string|Array<object>|null|undefined} content OpenAI message content
 * @returns {string} joined text content
 */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

/**
 * Return the full text of the last user message, used for classification and
 * fallback sizing.
 *
 * @param {object|null|undefined} body chat-completions request body
 * @returns {string} last user message text, or an empty string
 */
export function lastUserText(body) {
  if (!Array.isArray(body?.messages)) return '';
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i]?.role === 'user') return messageText(body.messages[i].content);
  }
  return '';
}

/**
 * Detect image, video, and audio inputs across OpenAI content parts and optional
 * attachment metadata. Sampled video frame markers count as video as well as
 * image input.
 *
 * @param {object|null|undefined} body chat-completions request body
 * @returns {{image:boolean, video:boolean, audio:boolean, any:boolean}} attachment flags
 */
export function attachmentPresence(body) {
  let image = false;
  let video = false;
  let audio = false;
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      const type = String(part?.type || '').toLowerCase();
      if (type === 'image_url' || type === 'input_image' || type === 'image') image = true;
      if (type === 'video_url' || type === 'input_video' || type === 'video') video = true;
      if (type === 'input_audio' || type === 'audio_url' || type === 'audio') audio = true;
      if (type === 'text' && /\[frame\s+\d+\/\d+\s+@\s+\d{1,2}:\d{2}\]/i.test(part.text || '')) {
        video = true;
      }
    }
  }
  for (const attachment of Array.isArray(body?.attachments) ? body.attachments : []) {
    const descriptor = [
      attachment?.type, attachment?.mime_type, attachment?.content_type,
      attachment?.name, attachment?.filename, attachment?.url,
    ].filter(Boolean).join(' ');
    if (/image/i.test(descriptor)) image = true;
    if (/video|youtu(?:\.be|be\.com)|\.(?:mp4|mov|webm|mkv)\b/i.test(descriptor)) video = true;
    if (/audio|\.(?:wav|mp3|flac|ogg|m4a)\b/i.test(descriptor)) audio = true;
  }
  return { image, video, audio, any: image || video || audio };
}

/**
 * Determine whether a model record is vision-capable. An operator override wins,
 * then explicit mmproj modalities, with the built-in name heuristic reserved for
 * records whose model directory has no projector metadata.
 *
 * @param {string|object} model model id or model record
 * @param {{routerVisionModels?: string[]}|null|undefined} config router configuration
 * @returns {boolean} whether the model is eligible for image-bearing requests
 */
export function isVisionModel(model, config = {}) {
  const record = typeof model === 'string' ? { id: model } : model;
  const id = typeof record?.id === 'string' ? record.id : '';
  const aliasTarget = typeof record?.aliasTarget === 'string' ? record.aliasTarget : '';
  const configured = new Set(
    (Array.isArray(config?.routerVisionModels) ? config.routerVisionModels : [])
      .filter(value => typeof value === 'string')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (configured.has(id.toLowerCase()) || configured.has(aliasTarget.toLowerCase())) return true;
  if (record?.capabilitySource === 'mmproj') {
    return Array.isArray(record.modalities) && record.modalities.includes('image');
  }
  return VISION_MODEL_PATTERN.test(id) || VISION_MODEL_PATTERN.test(aliasTarget);
}

/**
 * Determine whether a model record is audio-capable from projector modalities
 * or an operator-provided exact id in `config.routerAudioModels`.
 *
 * @param {string|object} model model id or model record.
 * @param {{routerAudioModels?: string[]}|null|undefined} config router configuration.
 * @returns {boolean} whether the model is eligible for audio-bearing requests.
 */
export function isAudioModel(model, config = {}) {
  const record = typeof model === 'string' ? { id: model } : model;
  const id = typeof record?.id === 'string' ? record.id : '';
  const aliasTarget = typeof record?.aliasTarget === 'string' ? record.aliasTarget : '';
  const configured = new Set(
    (Array.isArray(config?.routerAudioModels) ? config.routerAudioModels : [])
      .filter(value => typeof value === 'string')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return configured.has(id.toLowerCase())
    || configured.has(aliasTarget.toLowerCase())
    || (Array.isArray(record?.modalities) && record.modalities.includes('audio'));
}

/**
 * Produce the real classification candidate set, excluding embedding models and
 * restricting image/audio-bearing requests to models with both required
 * capabilities.
 *
 * @param {object} body chat-completions request body
 * @param {Array<string|object>|{data?: Array<string|object>}} models model catalog
 * @param {{routerVisionModels?: string[], routerAudioModels?: string[]}} [config] router configuration
 * @returns {Array<object>} eligible normalized model records
 */
export function filterRoutingCandidates(body, models, config = {}) {
  const normalized = normalizeModels(models);
  const attachments = attachmentPresence(body);
  return normalized.filter(model => (
    (!attachments.image || isVisionModel(model, config))
    && (!attachments.audio || isAudioModel(model, config))
  ));
}

/**
 * Infer compact model capability hints from catalog metadata and conventional
 * model names.
 *
 * @param {object} model normalized model record
 * @param {{routerVisionModels?: string[]}} config router configuration
 * @returns {string} comma-separated classifier hints
 */
function capabilityHints(model, config) {
  const id = model.id;
  const hints = [];
  if (isVisionModel(model, config)) hints.push('vision-capable');
  if (/code|coder|codestral|starcoder|devstral/i.test(id)) hints.push('coder');
  const size = Number(id.match(/(\d+(?:\.\d+)?)\s*b/i)?.[1]);
  if (id === 'default-big' || /large|big|gpt-oss|deepseek/i.test(id) || size >= 14) {
    hints.push('big/general');
  } else if (id === 'default-small' || /small|mini|flash|fast|tiny/i.test(id) || (size > 0 && size <= 9)) {
    hints.push('small/fast');
  }
  if (!hints.length) hints.push('general');
  return hints.join(', ');
}

/**
 * Build the compact two-message classifier prompt. Only the last user message is
 * included, truncated to 2,000 characters, plus attachment flags and candidates.
 *
 * @param {object} body chat-completions request body
 * @param {Array<string|object>|{data?: Array<string|object>}} models model catalog
 * @param {{routerVisionModels?: string[]}} [config] router configuration
 * @returns {Array<{role:string,content:string}>} classifier messages
 */
export function buildClassificationPrompt(body, models, config = {}) {
  const attachments = attachmentPresence(body);
  const candidates = filterRoutingCandidates(body, models, config);
  const catalogLines = candidates.map(model => `- ${model.id} [${capabilityHints(model, config)}]`);
  return [
    {
      role: 'system',
      content: 'Choose the best available model for the request. Reply with a single JSON object exactly like {"model":"<id>"}. Use only an id from the candidate list and add no other text.',
    },
    {
      role: 'user',
      content: [
        `Attachments: image=${attachments.image ? 'yes' : 'no'}, video=${attachments.video ? 'yes' : 'no'}`,
        'Candidate models:',
        catalogLines.join('\n') || '- none',
        'Last user request:',
        lastUserText(body).slice(0, MAX_ROUTER_TEXT_CHARS),
      ].join('\n'),
    },
  ];
}

/**
 * Extract classifier text from a raw string or OpenAI chat-completion response.
 *
 * @param {*} completion classifier result
 * @returns {string|null} response content
 */
function completionText(completion) {
  if (typeof completion === 'string') return completion;
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return messageText(content);
  return null;
}

/**
 * Parse and validate a classifier response against the exact candidate ids.
 *
 * @param {*} completion raw classifier completion
 * @param {Array<string|object>|{data?: Array<string|object>}} candidates eligible candidates
 * @returns {string|null} validated model id, or null for bad/unknown output
 */
export function parseRouterChoice(completion, candidates) {
  const text = completionText(completion);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.model !== 'string') return null;
    const choice = parsed.model.trim();
    const ids = new Set(normalizeModels(candidates).map(model => model.id));
    return ids.has(choice) ? choice : null;
  } catch {
    return null;
  }
}

/**
 * Select the deterministic route used whenever classification cannot complete:
 * short attachment-free messages use the small model; everything else uses big.
 *
 * @param {object} body chat-completions request body
 * @returns {'default-small'|'default-big'} fallback alias
 */
export function fallbackModel(body) {
  return !attachmentPresence(body).any && lastUserText(body).length < 200
    ? 'default-small'
    : 'default-big';
}

/**
 * Route an `auto`/`default-router` request through the default-small classifier.
 * The dependency seam keeps I/O in server.js; this function owns prompt creation,
 * timeout, validation, fallback, and the in-place `body.model` rewrite.
 *
 * @param {object} body chat-completions request body
 * @param {{
 *   listModels: function(): Promise<Array<string|object>|{data?:Array<string|object>}>,
 *   complete: function(string, Array<object>, object): Promise<*>,
 *   config?: {routerVisionModels?: string[], routerAudioModels?: string[]},
 *   timeoutMs?: number
 * }} deps injectable catalog/completion dependencies
 * @returns {Promise<string>} selected model id or default alias
 * @throws {Error} When an audio request has no known audio-capable fallback.
 */
export async function routeAutoModel(body, deps) {
  if (!AUTO_MODEL_ALIASES.includes(body?.model)) return body?.model;
  const fallback = fallbackModel(body);
  const attachments = attachmentPresence(body);
  const timeoutMs = Number.isFinite(deps?.timeoutMs) ? Math.max(0, deps.timeoutMs) : ROUTER_TIMEOUT_MS;
  const controller = new AbortController();
  let candidates = [];
  let timer;
  try {
    const models = await deps.listModels();
    candidates = filterRoutingCandidates(body, models, deps.config);
    if (!candidates.length) throw new Error('no eligible routing candidates');
    const messages = buildClassificationPrompt(body, candidates, deps.config);
    const completionWork = deps.complete('default-small', messages, {
      stream: false,
      temperature: 0,
      max_tokens: 64,
      signal: controller.signal,
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('router classification timed out'));
      }, timeoutMs);
    });
    const completion = await Promise.race([completionWork, timeout]);
    const choice = parseRouterChoice(completion, candidates);
    if (!choice) throw new Error('invalid router choice');
    body.model = choice;
    return choice;
  } catch {
    if (attachments.audio) {
      const audioFallback = candidates.find(model => model.id === fallback) || candidates[0];
      if (!audioFallback) throw new Error('no audio-capable routing candidate available');
      body.model = audioFallback.id;
      return audioFallback.id;
    }
    body.model = fallback;
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepend BASE_CHAT_PROMPT only for explicitly flagged Llama Manager chat-UI
 * requests that do not already contain any system message.
 *
 * @param {object} body chat-completions request body
 * @param {object|null|undefined} headers request headers (case-insensitive keys)
 * @returns {boolean} true when the prompt was injected
 */
export function injectBaseChatPrompt(body, headers = {}) {
  if (!Array.isArray(body?.messages)) return false;
  const headerValue = Object.entries(headers || {})
    .find(([key]) => key.toLowerCase() === 'x-llama-manager-chat')?.[1];
  const isManagerChat = body?.metadata?.llama_manager_chat === true || String(headerValue ?? '') === '1';
  if (!isManagerChat || body.messages.some(message => message?.role === 'system')) return false;
  body.messages.unshift({ role: 'system', content: BASE_CHAT_PROMPT });
  return true;
}
