// Llama Manager — group chat models into families and rank their members.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Collapses a flat model list into one row per family (DeepSeek-V4-Flash,
// Qwen3-8B, ...) with the highest-fidelity available member as the family's
// default, so the picker shows a handful of choices instead of every
// quantization of every model. Derives the family purely from the model name —
// no server-side metadata, no curated mapping to fall out of date — and exposes
// the full member list so a specific quantization can still be chosen
// deliberately.

// Quantization markers, matched against a single '-'/'.' separated name token.
//
// This is the cut point for the family name: everything BEFORE the first quant
// token is the family, everything from it on describes the build. Covers the
// forms this project actually serves — Q4_K_M, Q8_0, IQ2_XXS, the run-together
// IQ2XXS, and the float builds.
const QUANT_TOKEN = /^(?:UD[-_])?(?:I?Q\d|F16|BF16|FP16|FP8|MXFP4)/i;

// Multi-part GGUF suffix, e.g. `-00001-of-00004`. Not a quantization, but it
// must not survive into a family name or every split model becomes N families.
const SPLIT_PART = /-\d{5}-of-\d{5}$/i;

// Bits per weight for the quant families we rank. Higher is better fidelity;
// this is the primary sort key when picking a family's default member.
const QUANT_BITS = { f16: 16, bf16: 16, fp16: 16, q8: 8, q6: 6, q5: 5, q4: 4, fp8: 8, q3: 3, iq4: 4, iq3: 3, q2: 2, iq2: 2, mxfp4: 4, iq1: 1, q1: 1 };

// Variant suffix ordering within one bit width: XL beats L beats M beats S.
// Small on its own, but it is the difference between Q4_K_XL and Q4_K_S.
const VARIANT_RANK = { xl: 4, l: 3, m: 2, s: 1, xs: 0, xxs: -1 };

/**
 * Strip the file extension and any split-part suffix from a model name.
 *
 * @param {string} name Raw model id or filename.
 * @returns {string} The name with `.gguf`-style extensions and `-00001-of-000NN` removed.
 */
function baseName(name) {
  return String(name || '')
    .replace(/\.(gguf|bin|safetensors)$/i, '')
    .replace(SPLIT_PART, '');
}

/**
 * Derive a family name from a model name.
 *
 * The family is the leading run of tokens before the first quantization marker,
 * so `Qwen3-8B-Q4_K_M` and `Qwen3-8B-Q8_0` share the family `Qwen3-8B` while
 * `Qwen3-Coder-Next` stays distinct from `Qwen3-8B`.
 *
 * @param {string} name Raw model id or filename.
 * @returns {string} The family name; the whole (extension-stripped) name when it carries no quant marker.
 */
export function modelFamily(name) {
  const base = baseName(name);
  if (!base) return '';
  const parts = base.split('-');
  let cut = parts.findIndex((part) => QUANT_TOKEN.test(part));
  if (cut <= 0) return base;
  // Unsloth's dynamic builds write the marker as two tokens, `UD-Q4_K_XL`, so
  // splitting on '-' leaves a bare `UD` in front of the quant token. It
  // describes the build, not the model, and must not survive into the family.
  if (/^UD$/i.test(parts[cut - 1])) cut -= 1;
  if (cut <= 0) return base;
  return parts.slice(0, cut).join('-');
}

/**
 * Score a model by the fidelity of its quantization.
 *
 * Used only to order members WITHIN a family, so the absolute value carries no
 * meaning beyond "higher is a better build of the same model".
 *
 * @param {string} name Raw model id or filename.
 * @returns {number} Fidelity score; 0 when no quantization can be read from the name.
 */
export function modelQuality(name) {
  const base = baseName(name);
  const token = base.split('-').find((part) => QUANT_TOKEN.test(part));
  if (!token) return 0;
  const cleaned = token.replace(/^UD[-_]/i, '');
  const bitsKey = (cleaned.match(/^(i?q\d|f16|bf16|fp16|fp8|mxfp4)/i) || [''])[0].toLowerCase();
  const bits = QUANT_BITS[bitsKey] || 0;
  // The variant is whatever trails the bit marker (`_K_M`, `XXS`, `_0`).
  const tail = cleaned.slice(bitsKey.length).replace(/[_\s]/g, '').toLowerCase();
  const variant = VARIANT_RANK[tail.replace(/^k/, '')] ?? 0;
  return bits * 10 + variant;
}

/**
 * Collapse a model list into families, best member first.
 *
 * Family order follows the order families first appear in the input, so a
 * caller that already sorted its models (aliases first, say) keeps that
 * arrangement.
 *
 * @param {Array<{id:string, label?:string}>} models Models to group; `id` is the name the family is derived from.
 * @returns {Array<{family:string, best:object, members:Array<object>}>} One entry per family, `members` ordered best-first.
 */
export function groupModelsByFamily(models = []) {
  const byFamily = new Map();
  for (const model of models) {
    if (!model || !model.id) continue;
    const family = modelFamily(model.id) || model.id;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(model);
  }
  return [...byFamily.entries()].map(([family, members]) => {
    const ordered = [...members].sort((a, b) => modelQuality(b.id) - modelQuality(a.id));
    return { family, best: ordered[0], members: ordered };
  });
}
