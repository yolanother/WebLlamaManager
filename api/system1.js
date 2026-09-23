// Llama Manager — System 1 provider client (Laya / Jev).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Asks System 1 decision questions of the configured provider: the local Laya
// engine (through the decision router's peer → local walk, injected as askLaya),
// TypeSafe's hosted Jev API (POST https://api.typesafe.ai/v1/systemone with a
// bearer key), or Jev with a Laya fallback. Every failure throws an Error with
// a short `code` (no_jev_key, jev_<status>, laya_<status>, no_decision_host, …)
// that callers surface as a routing reason. No retries: callers own the budget.

/** TypeSafe's System 1 endpoint. */
export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';

/** Error carrying a short machine-readable code. */
function system1Error(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

/**
 * POST a Jev-wire body to TypeSafe. Resolves with the upstream status and
 * JSON body for any HTTP status; throws only when no key is set or fetch fails.
 * @param {object} body Jev request without `model` (questions, state)
 * @param {{fetchImpl:Function, jevApiKey:string, jevModel?:string, timeoutMs:number}} opts
 * @returns {Promise<{status:number, body:object}>}
 * @throws {Error} code no_jev_key, or jev_unreachable when fetch rejects
 */
export async function callJev(body, { fetchImpl, jevApiKey, jevModel, timeoutMs }) {
  if (!jevApiKey) throw system1Error('no_jev_key');
  let r;
  try {
    r = await fetchImpl(JEV_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jevApiKey}` },
      body: JSON.stringify({ ...body, model: body.model || jevModel }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw system1Error(err?.name === 'TimeoutError' ? 'jev_timeout' : 'jev_unreachable', err);
  }
  let json;
  try { json = await r.json(); } catch { json = { error: 'invalid_upstream_body' }; }
  return { status: r.status, body: json };
}

/** One provider leg: resolves with {answers, model} or throws a coded error. */
async function askOne(provider, body, timeoutMs, deps) {
  const r = provider === 'jev'
    ? await callJev(body, { ...deps, timeoutMs })
    : await deps.askLaya(body, { timeoutMs, allowColdStart: false, refresh: false });
  if (!r) throw system1Error('no_decision_host');
  if (r.status !== 200) throw system1Error(`${provider}_${r.status}`);
  return { answers: r.body?.answers, model: r.body?.model };
}

/**
 * Ask System 1 questions of a provider, trying Jev then Laya for 'jev-then-laya'.
 * @param {object} questions Jev-wire questions map
 * @param {string} state the text being judged
 * @param {{provider:string, timeoutMs:number}} opts provider and per-leg timeout
 * @param {{fetchImpl?:Function, jevApiKey?:string, jevModel?:string, askLaya?:Function}} deps
 * @returns {Promise<{answers:object, provider:string, model:string}>}
 * @throws {Error} the last leg's coded error when every leg fails
 */
export async function askSystem1(questions, state, { provider, timeoutMs }, deps) {
  const order = provider === 'jev' ? ['jev'] : provider === 'jev-then-laya' ? ['jev', 'laya'] : ['laya'];
  let last;
  for (const p of order) {
    try {
      return { ...(await askOne(p, { questions, state }, timeoutMs, deps)), provider: p };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
