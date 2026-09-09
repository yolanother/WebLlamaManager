/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Resolves the operator's named GPU pools against the cards actually present in
 * the machine, and reports each pool's capacity. A pool names a card CLASS --
 * its PCI vendor:device id and product name -- rather than a DRM index or a PCI
 * slot, so a named GPU survives both a kernel reorder of card0/card1 and the
 * card being re-plugged into a different port. Several cards of one class under
 * one name are not an ambiguity to be resolved: they are capacity, and callers
 * are told how much of it there is. Pure: it reads nothing and writes nothing,
 * so every case that matters here -- a two-card box, a card with no driver
 * bound, two pool entries fighting over one card -- is testable on hardware that
 * has one GPU.
 *
 * The failure this module is shaped around is a pool that matches EVERY card by
 * accident. A pool with no selectors is the vacuous "all constraints satisfied"
 * case, and reading it that way would silently hand one name the whole machine,
 * so it deliberately matches nothing and says so. Every other way a pool can
 * come up empty is likewise a warning naming the pool, never a silent zero:
 * hardware that is present and missing from the readout is the hardest kind of
 * fault to chase.
 */
import { formatPciId } from './gpu-inventory.js';

/**
 * Priority a pool grants at when the operator names none. Zero is
 * llama-manager's own baseline: negative yields to ordinary llama-manager work,
 * positive preempts it, and a claim takes a held card only if strictly higher.
 * @type {number}
 */
export const DEFAULT_POOL_PRIORITY = 0;

/**
 * The selectors a pool's `match` may name. Anything else in a `match` is an
 * operator typo, and it is rejected rather than ignored: a selector the module
 * never applies leaves the pool constrained by less than the operator wrote,
 * which is the route to a pool that matches every card in the machine.
 * @type {ReadonlyArray<string>}
 */
const MATCH_SELECTORS = ['pciId', 'name', 'pci'];

/**
 * Folds one selector value into the form comparisons are made in.
 *
 * @param {string} selector Which selector the value belongs to.
 * @param {string} value The operator's value, already known to be a string.
 * @returns {string} The comparison form: a `vendor:device` class id for `pciId`,
 *   and plain lower case for the address and name selectors, both of which are
 *   compared case-insensitively.
 * @throws {TypeError} When a `pciId` is not a `vendor:device` pair.
 */
function foldSelector(selector, value) {
  if (selector !== 'pciId') return value.trim().toLowerCase();
  const folded = formatPciId(value);
  if (!folded) {
    throw new TypeError(`GPU pool match.pciId must be a vendor:device pair such as "10de:2204", got ${JSON.stringify(value)}`);
  }
  return folded;
}

/**
 * Validates one settings entry and fills in the defaults it may omit.
 *
 * Runs at the trust boundary -- these values come from an operator-edited
 * settings file -- so it is strict about shape and deliberately lenient about
 * only one thing: an entry whose `match` is empty is accepted, because the
 * honest place to report that mistake is resolution, where the pool can be named
 * alongside its capacity of 0, rather than a throw that takes the whole settings
 * file down with it.
 *
 * @param {{id:string, label?:string, match?:object, pinnedModels?:Array<string>,
 *   defaultPriority?:number}} entry One entry from the settings `gpus` array.
 * @returns {{id:string, label:string, match:Object<string,string>,
 *   pinnedModels:Array<string>, defaultPriority:number}} The entry with every
 *   default applied and every selector folded to its comparison form, so the
 *   folding happens once at the edge rather than at every card comparison.
 * @throws {TypeError} When the entry is not an object, names no id, carries a
 *   `match` that is not an object of known selectors with non-empty string
 *   values, a `pinnedModels` that is not an array of non-empty strings, a
 *   non-string `label`, or a `defaultPriority` that is not an integer.
 */
export function normalizePoolConfig(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`GPU pool entry must be an object, got ${entry === null ? 'null' : typeof entry}`);
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) throw new TypeError('GPU pool entry needs a non-empty string id');

  if (entry.label !== undefined && typeof entry.label !== 'string') {
    throw new TypeError(`GPU pool "${id}" label must be a string`);
  }

  const rawMatch = entry.match ?? {};
  if (typeof rawMatch !== 'object' || rawMatch === null || Array.isArray(rawMatch)) {
    throw new TypeError(`GPU pool "${id}" match must be an object of selectors`);
  }
  const match = {};
  for (const [selector, value] of Object.entries(rawMatch)) {
    if (!MATCH_SELECTORS.includes(selector)) {
      throw new TypeError(`GPU pool "${id}" has unknown match selector "${selector}"; known selectors are ${MATCH_SELECTORS.join(', ')}`);
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`GPU pool "${id}" match.${selector} must be a non-empty string`);
    }
    match[selector] = foldSelector(selector, value);
  }

  const pinnedModels = entry.pinnedModels ?? [];
  if (!Array.isArray(pinnedModels) || pinnedModels.some((m) => typeof m !== 'string' || !m.trim())) {
    throw new TypeError(`GPU pool "${id}" pinnedModels must be an array of non-empty model names`);
  }

  const defaultPriority = entry.defaultPriority ?? DEFAULT_POOL_PRIORITY;
  if (!Number.isInteger(defaultPriority)) {
    throw new TypeError(`GPU pool "${id}" defaultPriority must be an integer, got ${JSON.stringify(entry.defaultPriority)}`);
  }

  return {
    id,
    // The id stands in as the label so a readout is never blank; an operator who
    // wants a friendlier name says so, and one who does not still gets a handle.
    label: entry.label || id,
    match,
    pinnedModels: [...pinnedModels],
    defaultPriority,
  };
}

/**
 * The comparison form of the value a card offers for one selector.
 *
 * A card reaches this module in either of two shapes -- `readCardSysfs` hands
 * over the raw `vendorId`/`deviceId` pair, `buildInventory` hands over a composed
 * `pciId` -- and both must match, so the class is resolved from whichever is
 * present.
 *
 * @param {object} card The card.
 * @param {string} selector One of MATCH_SELECTORS.
 * @returns {?string} The card's value folded for comparison, or null when the
 *   card cannot answer for that selector.
 */
function cardSelectorValue(card, selector) {
  if (selector === 'pciId') return formatPciId(card.vendorId, card.deviceId) || formatPciId(card.pciId);
  const value = selector === 'pci' ? card.pci : card.name;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Whether one card belongs to a pool's `match`.
 *
 * Selectors present are ANDed; selectors omitted are ignored, so `pciId` alone
 * is the normal case and it survives a re-plug into another slot. `pciId` and
 * `pci` compare exactly, case-insensitively and with sysfs's `0x` prefix
 * optional; `name` is a case-insensitive substring, because the resolved name is
 * whatever the local PCI database produced and an operator should not have to
 * reproduce it in full.
 *
 * An empty or missing `match` matches NOTHING. That is the deliberate reading:
 * the vacuous-truth alternative would quietly give one pool every card in the
 * machine, which is the dangerous failure here.
 *
 * @param {?object} card A card from `readCardSysfs` or `buildInventory`.
 * @param {?Object<string,string>} match A pool's selectors, folded or raw.
 * @returns {boolean} True only when the card answers for every selector present
 *   and at least one selector is present.
 */
export function cardMatchesPool(card, match) {
  if (!card || typeof card !== 'object') return false;
  if (!match || typeof match !== 'object') return false;
  const selectors = MATCH_SELECTORS.filter((s) => typeof match[s] === 'string' && match[s].trim());
  if (selectors.length === 0) return false;

  return selectors.every((selector) => {
    const want = foldSelector(selector, match[selector]);
    const have = cardSelectorValue(card, selector);
    if (have === null) return false;
    return selector === 'name' ? have.includes(want) : have === want;
  });
}

/**
 * Whether two card records describe the same physical card.
 *
 * The DRM index is unique within one scan, and the PCI address is unique across
 * scans, so either identifies a card; both are tried because a caller holding a
 * grant from an earlier scan may have only one of them.
 *
 * @param {?object} a First card.
 * @param {?object} b Second card.
 * @returns {boolean} True when they are the same card.
 */
function sameCard(a, b) {
  if (!a || !b) return false;
  if (a.card && b.card && a.card === b.card) return true;
  const pci = (card) => (typeof card.pci === 'string' ? card.pci.trim().toLowerCase() : '');
  return Boolean(pci(a)) && pci(a) === pci(b);
}

/**
 * Resolves every named pool against the cards present, with its capacity.
 *
 * Capacity counts only cards a driver is bound to. A card with none is still
 * listed in the pool -- hardware that is physically there must not vanish from a
 * readout -- but nothing can execute on it, so it is not capacity.
 *
 * A card matched by two pools goes to the FIRST in config order. Config order is
 * chosen over any cleverer tie-break because it is deterministic and the
 * operator can see it; both pools are warned so the collision is never silent.
 *
 * @param {?Array<object>} poolConfigs Settings entries, in the operator's order.
 * @param {?Array<object>} cards Cards present, from `readCardSysfs` or
 *   `buildInventory`.
 * @returns {Array<{id:string, label:string, match:Object<string,string>,
 *   pinnedModels:Array<string>, defaultPriority:number, capacity:number,
 *   cards:Array<object>, warnings:Array<string>}>} One entry per pool, in config
 *   order. `cards` holds the card records themselves so a caller can name the
 *   card a grant binds to; `warnings` is empty when nothing is wrong.
 * @throws {TypeError} When any entry fails {@link normalizePoolConfig}: a
 *   settings file is validated as a whole, not resolved half-broken.
 */
export function resolvePools(poolConfigs, cards) {
  const configs = Array.isArray(poolConfigs) ? poolConfigs : [];
  const present = Array.isArray(cards) ? cards : [];
  const pools = configs.map((entry) => ({
    ...normalizePoolConfig(entry),
    capacity: 0,
    cards: [],
    warnings: [],
  }));

  // Assignment is a single pass over the pools in config order, so the first
  // pool that wants a card keeps it and later pools see it already taken.
  const owner = new Map();
  for (const pool of pools) {
    for (const card of present) {
      if (!cardMatchesPool(card, pool.match)) continue;
      const held = owner.get(card);
      if (held) {
        const warning = `GPU pools "${held.id}" and "${pool.id}" both match ${card.card || card.pci || 'a card'}; it is assigned to "${held.id}" because it is first in the settings order`;
        held.warnings.push(warning);
        pool.warnings.push(warning);
        continue;
      }
      owner.set(card, pool);
      pool.cards.push(card);
      if (card.available !== false) pool.capacity += 1;
    }
  }

  for (const pool of pools) {
    if (Object.keys(pool.match).length === 0) {
      pool.warnings.push(`GPU pool "${pool.id}" has no match selectors, so it matches no card; name a pciId, name or pci to give it one`);
    } else if (pool.cards.length === 0 && pool.warnings.length === 0) {
      // Only when the pool matched nothing at all. A pool that matched cards and
      // lost every one of them to an earlier pool already carries a warning
      // saying exactly that, and repeating "no card is present" would be false.
      pool.warnings.push(`GPU pool "${pool.id}" matches no card present in this machine`);
    } else if (pool.capacity === 0 && pool.cards.length > 0) {
      pool.warnings.push(`GPU pool "${pool.id}" matches ${pool.cards.length === 1 ? 'a card' : 'cards'} with no kernel driver bound, so it has no usable capacity`);
    }
  }

  return pools;
}

/**
 * Which resolved pool owns a given card, if any.
 *
 * @param {?Array<object>} pools Output of {@link resolvePools}.
 * @param {?object} card The card to look up, identified by its DRM index or its
 *   PCI address -- the reservation layer holds a card across a rescan, and the
 *   DRM index it was granted under can be gone by then while the address is not.
 * @returns {?object} The owning pool, or null when no pool claims the card.
 */
export function poolForCard(pools, card) {
  if (!Array.isArray(pools) || !card) return null;
  return pools.find((pool) => pool.cards.some((owned) => sameCard(owned, card))) || null;
}
