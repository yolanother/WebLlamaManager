// Llama Manager — main-node designation for appliance federation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Decides which appliance in a fleet coordinates the others. The election is
// deterministic and convergent rather than negotiated: every node ranks the same
// set of node ids the same way, so all of them reach the same answer without
// exchanging a single message, and transiently different views settle by
// themselves as discovery converges. That is the whole protocol — there are no
// terms, no votes, and no quorum, because the failure this has to survive is a
// thumb drive being pulled out of a desk, not a partitioned datacentre.
//
// An operator's explicit choice outranks the election and travels to the rest of
// the fleet in the advertised TXT records, because the operator will have
// opinions about which box is the good one and a system that re-elects around
// them is infuriating.
//
// Authority is deliberately soft. Nothing here can stop a node serving its own
// users: a secondary that loses sight of the main node simply becomes main of
// what remains. Two mains on a desk costs nothing; a node that stops working
// costs everything.

/** Role of the node that coordinates the fleet. @type {string} */
export const ROLE_MAIN = 'main';

/** Role of a node that serves inference on request. @type {string} */
export const ROLE_SECONDARY = 'secondary';

/**
 * Read a usable node id off a discovered peer.
 *
 * @param {Object} entry A peer from discovery.
 * @returns {string|null} The peer's node id, or null when it advertised none.
 */
function peerId(entry) {
  const id = entry?.txt?.id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Decide which node id should coordinate this fleet.
 *
 * Pinned nodes are considered first as a group; within whichever group applies
 * the lowest id wins. A node does NOT prefer its own pin over a peer's — if it
 * did, two pinned nodes would each believe they were main and the fleet would
 * never converge on one answer.
 *
 * A node that cannot state its own id takes itself out of the running rather
 * than claiming anything, since a main node whose identity is unknown is one the
 * rest of the fleet cannot address or agree about.
 *
 * @param {Object} view
 * @param {string|null} view.selfId This node's id.
 * @param {Array<Object>} view.peers Peers from discovery.
 * @param {boolean} [view.pinned] Whether the operator pinned THIS node as main.
 * @returns {string|null} Node id that should be main; null when nothing is known.
 */
export function electMain({ selfId, peers = [], pinned = false } = {}) {
  const candidates = [];
  if (selfId) candidates.push({ id: selfId, pinned: !!pinned });
  for (const entry of Array.isArray(peers) ? peers : []) {
    const id = peerId(entry);
    if (id) candidates.push({ id, pinned: entry?.txt?.pin === '1' });
  }
  if (!candidates.length) return null;

  const pool = candidates.some((c) => c.pinned)
    ? candidates.filter((c) => c.pinned)
    : candidates;
  return pool.map((c) => c.id).sort()[0];
}

/**
 * Decide what role this node currently carries.
 *
 * A node alone is main of a fleet of one — including a node that does not know
 * its own id, because there is nobody to disagree with and waiting on an
 * election it can never win would leave it useless.
 *
 * @param {Object} view Same shape as {@link electMain}.
 * @returns {string} {@link ROLE_MAIN} or {@link ROLE_SECONDARY}.
 */
export function roleFor(view) {
  const peers = Array.isArray(view?.peers) ? view.peers : [];
  if (!peers.some(peerId)) return ROLE_MAIN;
  const main = electMain(view);
  return main && main === view?.selfId ? ROLE_MAIN : ROLE_SECONDARY;
}

/**
 * Build the TXT fields that tell the fleet what this node is.
 *
 * The pin is advertised, not just stored, because that is how a choice made on
 * one node's screen reaches every other node — there is no other channel.
 *
 * @param {Object} state
 * @param {string} state.role Current role.
 * @param {boolean} state.pinned Whether the operator pinned this node.
 * @returns {{role: string, pin: string}} Fields for the advertisement.
 */
export function designationTxt({ role, pinned } = {}) {
  return { role: role || ROLE_SECONDARY, pin: pinned ? '1' : '' };
}
