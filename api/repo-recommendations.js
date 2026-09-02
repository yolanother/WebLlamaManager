// Llama Manager — repo-file quantization ranking + fit + recommendation.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure logic behind GET /api/repo/:author/:model/files: turns a flat list of
// GGUF files (a HuggingFace repo listing, or a ds4 ggufDir listing) into the
// grouped-by-quantization response the model picker renders, annotated with a
// numeric rank (bit depth), a memory-fit verdict per entry, and a single
// `recommended` pick. Capacity is injected by the caller (server.js reads it
// from gpu-inventory.js + /proc/meminfo) so this module has no I/O and is
// fully unit-testable. Reuses `checkModelFit` from resource-guard.js for the
// llama engine; ds4 models use a simpler fixed-headroom rule because ds4's own
// server does its own KV-cache sizing.

import { basename } from 'node:path';
import { DEFAULTS, checkModelFit } from './resource-guard.js';

/** Fraction of capacity a ds4 model's file size must stay under to be offered.
 * ponytail: fixed fraction rather than ds4's own KV/context math (that lives
 * in ds4-server, not here) — revisit if ds4 models start getting recommended
 * too aggressively/conservatively in practice. */
const DS4_HEADROOM_FRACTION = 0.70;

const TOKEN_PATTERNS = [
  /[-_](UD[-_])?(Q\d+_K(?:_[A-Z]{1,3})?)/i,
  /[-_](UD[-_])?(IQ\d+_[A-Z]+)/i,
  /[-_](UD[-_])?(F16|F32|BF16)/i,
  /[-_](UD[-_])?(Q\d+_0)/i,
  // Bare "Qn": must not be immediately followed by another letter, or this
  // would misfire on non-quant tokens that merely start with Qn, e.g. the
  // "Q4KExperts" segment of a ds4 expert-count filename.
  /[-_](UD[-_])?(Q\d+)(?![A-Z])/i,
];

/**
 * Extract the recognized quantization token from a GGUF filename, e.g.
 * 'Q4_K_M', 'IQ2_M', 'BF16', or 'UD-Q4_K_XL' (unsloth dynamic quants keep
 * their UD- prefix). Returns null when no token is recognized.
 * @param {string} filename
 * @returns {string|null}
 */
export function extractQuantization(filename) {
  const cleanName = String(filename || '').replace(/[-_]\d{5}-of-\d{5}\.gguf$/i, '.gguf');
  for (const pattern of TOKEN_PATTERNS) {
    const match = cleanName.match(pattern);
    if (match) {
      const token = match[2].toUpperCase();
      return match[1] ? `UD-${token}` : token;
    }
  }
  return null;
}

/** Numeric rank for a recognized quant token: bit depth, IQ variants half a
 * step below their same-numbered Q sibling, F16/F32/BF16 pinned at 5.5. */
function quantRank(token) {
  const t = String(token).replace(/^UD-/i, '');
  if (/^(F16|F32|BF16)$/i.test(t)) return 5.5;
  let m = t.match(/^IQ(\d+)/i);
  if (m) return parseInt(m[1], 10) - 0.5;
  m = t.match(/^Q(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/** Best-effort rank for a file with no recognized quant token: the first
 * Qn/IQn-shaped token found anywhere in the name, else 0. */
function fallbackRank(name) {
  const m = String(name).match(/(IQ|Q)(\d+)/i);
  if (!m) return 0;
  const n = parseInt(m[2], 10);
  return m[1].toUpperCase() === 'IQ' ? n - 0.5 : n;
}

/**
 * Capacity (bytes) a model's weights + KV must fit inside. Mirrors the kiosk
 * dashboard's GPU-vs-system-RAM reasoning: an integrated card can borrow
 * system RAM via GTT, so its usable budget is the larger of its dedicated
 * VRAM and its (GTT-capped) share of total RAM; a discrete-only box falls
 * back to total system RAM.
 * @param {Array<{kind:string, vramBytes:?number, gttBytes:?number}>} gpus buildInventory() result.
 * @param {number} totalMemBytes Total system RAM in bytes.
 * @returns {number}
 */
export function computeCapacityBytes(gpus, totalMemBytes) {
  const integrated = (Array.isArray(gpus) ? gpus : []).filter((g) => g.kind === 'integrated');
  if (integrated.length === 0) return totalMemBytes || 0;
  return Math.max(
    ...integrated.map((g) => Math.max(g.vramBytes || 0, Math.min(g.gttBytes || 0, totalMemBytes || 0)))
  );
}

function computeFit({ totalSize, engine, capacityBytes, minContext }) {
  if (engine === 'ds4') {
    const budgetBytes = (capacityBytes || 0) * DS4_HEADROOM_FRACTION;
    return {
      fits: totalSize <= budgetBytes,
      requiredBytes: totalSize,
      budgetBytes,
      reason: 'ds4 headroom',
    };
  }
  return checkModelFit({
    fileBytes: totalSize,
    contextSize: minContext,
    availableBytes: capacityBytes,
    totalBytes: capacityBytes,
  });
}

function compareEntries(a, b) {
  if (a.kind === 'mmproj' || b.kind === 'mmproj') {
    if (a.kind !== b.kind) return a.kind === 'mmproj' ? 1 : -1;
  }
  if (a.fit.fits !== b.fit.fits) return a.fit.fits ? -1 : 1;
  if (a.rank !== b.rank) return b.rank - a.rank;
  return b.totalSize - a.totalSize;
}

/** ds4 ordering: the repo's names carry no comparable quant tokens, so the
 * weights (largest) lead and the small MTP/vision/support files follow. */
function compareDs4Entries(a, b) {
  if (a.kind === 'mmproj' || b.kind === 'mmproj') {
    if (a.kind !== b.kind) return a.kind === 'mmproj' ? 1 : -1;
  }
  if (a.fit.fits !== b.fit.fits) return a.fit.fits ? -1 : 1;
  return b.totalSize - a.totalSize;
}

/**
 * Pick the ds4 recommendation: the file a ds4 preset is configured to run when
 * it fits, else the largest fitting file whose name says `imatrix` (the
 * known-good DeepSeek V4 Flash quant on this class of box), else the largest
 * fitting file. ponytail: name heuristic instead of a curated catalog; add a
 * catalog if antirez publishes a second family under the same repo.
 * @param {Array<object>} entries Sorted ds4 entries.
 * @param {Set<string>} preferred Basenames of preset-configured ds4 models.
 * @returns {object|undefined}
 */
function pickDs4Recommended(entries, preferred) {
  const fitting = entries.filter((e) => e.kind !== 'mmproj' && e.fit.fits);
  return fitting.find((e) => preferred.has(basename(e.files[0])))
    || fitting.find((e) => /imatrix/i.test(e.quantization))
    || fitting[0];
}

/**
 * Group a repo's GGUF files by quantization and annotate each group with a
 * rank, a memory-fit verdict, and (for ds4) whether it is already present on
 * disk, then pick a single recommendation.
 * @param {object} a
 * @param {Array<{path:string, size:number}>} a.files Flat file listing.
 * @param {'llama'|'ds4'} [a.engine] Which fit rule + response shape to use.
 * @param {string} [a.ggufDir] Echoed back for ds4 (the dir `files` was listed from).
 * @param {Iterable<string>} [a.presentNames] Filenames already present on disk (ds4 only).
 * @param {Iterable<string>} [a.preferredNames] Filenames ds4 presets are configured to run (ds4 only); the recommendation prefers these.
 * @param {number} a.capacityBytes Injected memory/VRAM budget (bytes).
 * @param {number} [a.minContext] Context size used for the llama fit estimate.
 * @returns {{engine:string, ggufDir?:string, recommended:(string|null),
 *   quantizations:Array<object>}}
 */
export function buildRepoRecommendations({
  files = [],
  engine = 'llama',
  ggufDir,
  presentNames,
  preferredNames,
  capacityBytes,
  minContext = DEFAULTS.minContext,
} = {}) {
  const presentSet = presentNames ? new Set(Array.from(presentNames, (n) => basename(n))) : null;
  const preferredSet = new Set(Array.from(preferredNames || [], (n) => basename(n)));
  // ds4 repo names (e.g. `...-IQ2XXS-w2Q2K-AProjQ8-...-F32.gguf`) carry tokens that
  // only look like quants, so ds4 never groups by token: one entry per file.
  const groupByToken = engine !== 'ds4';
  const groups = new Map();
  const singles = [];

  for (const file of files) {
    const base = basename(file.path);
    const isMmproj = /mmproj/i.test(base);
    const quant = isMmproj ? null : extractQuantization(base);
    const kind = isMmproj ? 'mmproj' : (groupByToken && quant ? 'quant' : 'file');

    if (kind === 'quant') {
      const splitMatch = base.match(/[-_](\d{5})-of-(\d{5})\.gguf$/i);
      if (!groups.has(quant)) {
        groups.set(quant, { quantization: quant, kind, files: [], totalSize: 0, isSplit: false, totalParts: 1 });
      }
      const entry = groups.get(quant);
      entry.files.push(file.path);
      entry.totalSize += file.size || 0;
      if (splitMatch) {
        entry.isSplit = true;
        entry.totalParts = parseInt(splitMatch[2], 10);
      }
    } else {
      singles.push({
        quantization: base.replace(/\.gguf$/i, ''),
        kind,
        files: [file.path],
        totalSize: file.size || 0,
        isSplit: false,
        totalParts: 1,
      });
    }
  }

  const entries = [...groups.values(), ...singles];
  for (const entry of entries) {
    entry.pattern = entry.kind === 'quant' ? `*${entry.quantization}*.gguf` : basename(entry.files[0]);
    entry.rank = entry.kind === 'quant' ? quantRank(entry.quantization) : fallbackRank(entry.quantization);
    entry.fit = computeFit({ totalSize: entry.totalSize, engine, capacityBytes, minContext });
    entry.present = presentSet ? entry.files.every((f) => presentSet.has(basename(f))) : false;
  }
  entries.sort(engine === 'ds4' ? compareDs4Entries : compareEntries);

  const recommendedEntry = engine === 'ds4'
    ? pickDs4Recommended(entries, preferredSet)
    : entries.find((e) => e.kind === 'quant' && e.fit.fits);

  const result = {
    engine,
    recommended: recommendedEntry ? recommendedEntry.quantization : null,
    quantizations: entries,
  };
  if (engine === 'ds4') result.ggufDir = ggufDir;
  return result;
}
