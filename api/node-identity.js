// Llama Manager — appliance node identity naming rules.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Owns every rule that turns a human's or the local model's idea of a name into
// the single mDNS label an appliance is actually reachable at,
// "<name>-llama-manager.local". One flat label is deliberate: a three-label name
// under .local needs CNAME publication and does not resolve from macOS, Windows,
// or iOS, which is precisely where zero-configuration access has to work. The
// module is pure and dependency-injected — the caller supplies the completion
// call and the collision probe — so the naming rules can be exercised without an
// engine, a network, or a hostname to change. Every entry point fails closed by
// returning no name rather than a bad one, because a caller that gets nothing
// keeps the name the box already answers to instead of going unreachable.

/**
 * Name an appliance carries before any theme has been chosen, so a freshly
 * flashed box is already addressable at setup-llama-manager.local.
 * @type {string}
 */
export const BOOTSTRAP_NAME = 'setup';

/**
 * Suffix appended to every node name to form its hostname.
 * @type {string}
 */
export const NODE_SUFFIX = '-llama-manager';

/**
 * Longest node name accepted. A DNS label may be 63 characters and the suffix
 * costs 14 of them, so this is a readability cap well inside the real limit —
 * which is why a collision suffix appended afterwards is allowed to exceed it.
 * @type {number}
 */
export const MAX_NAME_LENGTH = 24;

/** Most candidates ever offered, so the kiosk shows a list, not a wall. */
const MAX_CANDIDATES = 8;

/** Words a bare line may contain and still plausibly be a name, not prose. */
const MAX_CANDIDATE_WORDS = 2;

/** Hyphens a normalized candidate may contain before it reads as a sentence. */
const MAX_CANDIDATE_HYPHENS = 2;

/**
 * Reduce arbitrary text to a legal, readable node name.
 *
 * Accents are folded to ASCII rather than dropped so a themed name in a
 * non-English language degrades to something recognisable instead of initials.
 * Everything outside `[a-z0-9-]` becomes a separator, runs collapse, and the
 * result is trimmed of dashes both before and after the length cap so a name
 * truncated mid-word can never publish a trailing dash.
 *
 * @param {unknown} raw Candidate name from an operator, a file, or the model.
 * @returns {string|null} The normalized name, or null when nothing usable remains.
 */
export function normalizeNodeName(raw) {
  if (typeof raw !== 'string') return null;
  const folded = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const collapsed = folded.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-|-$/g, '');
  if (!trimmed) return null;
  const capped = trimmed.slice(0, MAX_NAME_LENGTH).replace(/-$/, '');
  return capped || null;
}

/**
 * Build the system hostname a node name resolves to.
 *
 * @param {string} name Normalized node name.
 * @returns {string} Single-label hostname, e.g. "nebula-llama-manager".
 */
export function hostnameFor(name) {
  return `${name}${NODE_SUFFIX}`;
}

/**
 * Build the URL an operator types to reach this node from another machine.
 *
 * @param {string} name Normalized node name.
 * @returns {string} e.g. "http://nebula-llama-manager.local".
 */
export function urlFor(name) {
  return `http://${hostnameFor(name)}.local`;
}

/**
 * Recover the node name from a hostname this appliance published.
 *
 * Used to report identity from the live system rather than only from the stored
 * file, so a hostname changed out from under the manager is visible as such.
 *
 * @param {unknown} hostname System hostname, with or without a .local suffix.
 * @returns {string|null} The node name, or null when the hostname was not one
 *   this appliance chose.
 */
export function nameFromHostname(hostname) {
  if (typeof hostname !== 'string') return null;
  const bare = hostname.trim().toLowerCase().replace(/\.local\.?$/, '');
  if (!bare.endsWith(NODE_SUFFIX)) return null;
  return normalizeNodeName(bare.slice(0, -NODE_SUFFIX.length));
}

/**
 * Decide whether one raw line or JSON item can be a name at all.
 *
 * The model is asked for names and frequently answers with a sentence anyway.
 * Word and hyphen counts are what separate "storm crow" from "Here are some
 * great names for your machine:" once both have been normalized into something
 * that is technically a legal label.
 *
 * @param {string} raw Untrimmed candidate text.
 * @returns {string|null} The accepted normalized name, or null.
 */
function acceptCandidate(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^[\s>*+•-]*\d*[.)]?\s*/, '').trim();
  if (!text || text.endsWith(':')) return null;
  if (text.split(/\s+/).length > MAX_CANDIDATE_WORDS) return null;
  const name = normalizeNodeName(text);
  if (!name) return null;
  if ((name.match(/-/g) || []).length > MAX_CANDIDATE_HYPHENS) return null;
  return name;
}

/**
 * Extract node names from whatever the local model actually replied with.
 *
 * The model is asked for a JSON array and usually obliges, sometimes inside a
 * code fence or a sentence, so the array is looked for first. When there is no
 * array the reply is read line by line and comma by comma instead. Nothing is
 * trusted: every candidate goes through the same acceptance rules, and a reply
 * that yields nothing yields an empty list rather than a guess.
 *
 * @param {unknown} text Raw assistant message content.
 * @returns {string[]} Unique accepted names, at most {@link MAX_CANDIDATES}.
 */
/**
 * Reads the usable text out of an assistant message.
 *
 * A REASONING MODEL MAY NEVER EMIT `content` AT ALL. Measured on the appliance:
 * Qwen3 reasons before it answers, and with a 200-token budget it spent the
 * whole budget thinking and returned `finish_reason: "length"` with an empty
 * content string and its work-in-progress in `reasoning_content`. The parser
 * saw "" and the kiosk reported that the model had returned no usable names --
 * blaming the model for a reply that was cut off mid-thought.
 *
 * Real content always wins. The reasoning is a fallback, not a preference: it
 * is a draft, and every candidate pulled from it still has to pass the same
 * acceptance rules as one the model committed to.
 *
 * @param {unknown} message An assistant message object.
 * @returns {string} The best available text, or an empty string.
 */
export function readCompletionText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (content) return content;
  const reasoning =
    typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
  return reasoning;
}

export function parseNameCandidates(text) {
  if (typeof text !== 'string') return [];

  let items = null;
  const array = text.match(/\[[\s\S]*\]/);
  if (array) {
    try {
      const parsed = JSON.parse(array[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = null;
    }
  }
  if (!items) items = text.split(/[\n,]/);

  const names = [];
  for (const item of items) {
    const name = acceptCandidate(typeof item === 'string' ? item : '');
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= MAX_CANDIDATES) break;
  }
  return names;
}

/**
 * Pick the first free variant of a name.
 *
 * "Unique-ish" is the honest goal: the probe is an mDNS lookup that answers only
 * for nodes currently on this link, so a probe that fails, times out, or throws
 * is read as "no collision" rather than blocking. Exhausting every variant
 * returns the original — a possibly-colliding name still leaves the box named
 * and reachable, which an empty name would not.
 *
 * @param {string} base Normalized node name to start from.
 * @param {(name: string) => Promise<boolean>} isTaken Collision probe.
 * @returns {Promise<string>} A name to use; never empty.
 */
export async function disambiguate(base, isTaken) {
  for (let n = 1; n <= 9; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    let taken = false;
    try {
      taken = await isTaken(candidate);
    } catch {
      taken = false;
    }
    if (!taken) return candidate;
  }
  return base;
}

/**
 * Build the chat messages that ask the local model for themed node names.
 *
 * Exported so the request can be asserted on directly, and so a caller that
 * wants to route the completion somewhere else can build the same prompt.
 *
 * @param {string} theme Operator's naming theme, e.g. "weather".
 * @returns {Array<{role:string, content:string}>} OpenAI-shaped messages.
 */
export function buildSuggestionMessages(theme) {
  return [
    {
      role: 'system',
      content:
        'You name computers. Reply with ONLY a JSON array of '
        + `${MAX_CANDIDATES} short names, nothing else. Each name is one or two `
        + `lowercase words, letters and digits only, at most ${MAX_NAME_LENGTH} `
        + 'characters, and must not contain the words "llama" or "manager".',
    },
    { role: 'user', content: `Naming theme: ${theme}` },
  ];
}

/**
 * Ask the local model for node names on a theme.
 *
 * Every failure mode — no theme, no engine, a refusal, a wall of prose — is
 * reported as an empty candidate list plus a reason, never as a thrown error and
 * never as a name. The caller is expected to keep the name the node already has.
 *
 * @param {Object} options
 * @param {string} options.theme Operator's naming theme.
 * @param {(messages: Array<Object>) => Promise<string>} options.complete Runs one
 *   chat completion against the local model and resolves its text content.
 * @param {(name: string) => Promise<boolean>} [options.isTaken] Optional
 *   collision probe applied to each candidate.
 * @returns {Promise<{candidates: string[], error?: string}>} Names to offer.
 */
export async function suggestNames({ theme, complete, isTaken }) {
  const wanted = typeof theme === 'string' ? theme.trim().slice(0, 80) : '';
  if (!wanted) return { candidates: [], error: 'A naming theme is required.' };

  let names;
  try {
    names = parseNameCandidates(await complete(buildSuggestionMessages(wanted)));
  } catch (error) {
    return { candidates: [], error: String(error && error.message ? error.message : error) };
  }

  if (!names.length) {
    return { candidates: [], error: 'The model returned no usable names.' };
  }
  if (!isTaken) return { candidates: names };

  const candidates = [];
  for (const name of names) candidates.push(await disambiguate(name, isTaken));
  return { candidates };
}
