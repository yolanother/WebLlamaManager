// Llama Manager — what an appliance tells the rest of the fleet about itself.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Builds the DNS-SD advertisement an appliance publishes under
// `_llama-manager._tcp`: a stable node id, the name and role it currently
// carries, the state of its engine, and the capability record that tells a peer
// whether this box can actually run a given piece of work. Publication itself is
// a file — avahi-daemon reads `/etc/avahi/services/*.service` and reloads on
// change with no restart and no tooling, which is the entire mechanism, since
// the appliance image ships avahi-daemon but none of avahi-utils.
//
// The capability record is deliberately a hardware-and-backend triple rather
// than an inventory of model names. "Can this peer run model X" is answered by
// which engine backends it has and how much memory a model may occupy; which
// models happen to be on disk is a separate, per-node question. It matters
// because a fleet is expected to be mixed: an AMD APU whose usable memory is its
// GTT rather than its nominal 1 GB of VRAM, beside an NVIDIA box whose usable
// memory is its VRAM, running a different engine build.
//
// Every function here is pure and takes what it needs as arguments, so the
// advertisement can be exercised without a GPU, a machine id, or avahi.

import { createHmac } from 'node:crypto';

/**
 * Version of the TXT record schema. Peers read this before anything else so a
 * later phase can change the record set without confusing an older node.
 * @type {string}
 */
export const ADVERTISEMENT_VERSION = '1';

/**
 * Path avahi reads service definitions from, and the file this node owns in it.
 * @type {string}
 */
export const SERVICE_FILE_PATH = '/etc/avahi/services/llama-manager.service';

/**
 * Domain separator for the node id hash, so the published id cannot be
 * correlated with any other value derived from the same machine id.
 */
const NODE_ID_KEY = 'llama-manager-node-id';

/** Characters a DNS-SD TXT string may occupy, per RFC 6763. */
const MAX_TXT_BYTES = 255;

/**
 * PCI vendor ids, most capable first. Order is the tie-break for a machine that
 * reports more than one GPU: a workstation with a discrete card also reports the
 * integrated adapter beside it, and advertising the integrated one would tell
 * the fleet this box can run nothing.
 */
const GPU_VENDORS = [
  ['0x10de', 'nvidia'],
  ['0x1002', 'amd'],
  ['0x8086', 'intel'],
];

/**
 * Derive this node's stable fleet identity from its machine id.
 *
 * Keyed rather than raw: systemd documents the machine id as a value that must
 * not be exposed, and this one is broadcast to every machine on the link. The id
 * is what discovery keys peers on, because a node's NAME moves — an operator
 * renames it, and an unconfigured node steps aside from a bootstrap name another
 * box already holds — while its identity must not.
 *
 * @param {unknown} machineId Contents of /etc/machine-id.
 * @returns {string|null} Sixteen hex characters, or null when there is no id.
 */
export function nodeIdFrom(machineId) {
  if (typeof machineId !== 'string') return null;
  const trimmed = machineId.trim();
  if (!trimmed) return null;
  return createHmac('sha256', NODE_ID_KEY).update(trimmed).digest('hex').slice(0, 16);
}

/**
 * Decide which GPU vendor this node should advertise.
 *
 * @param {string[]|null} vendors PCI vendor ids read from /sys/class/drm/card*.
 * @returns {string} "nvidia", "amd", "intel", "unknown", or "none".
 */
export function gpuVendorFrom(vendors) {
  if (!Array.isArray(vendors) || !vendors.length) return 'none';
  const seen = vendors.map((id) => String(id).trim().toLowerCase());
  for (const [id, name] of GPU_VENDORS) {
    if (seen.includes(id)) return name;
  }
  return 'unknown';
}

/**
 * Report how much memory a model may actually occupy on this node, in MiB.
 *
 * The larger of VRAM and GTT wins, and that is the whole point. On an APU the
 * dedicated VRAM figure is a nominal 1 GB while real model memory comes from
 * GTT out of system RAM; on a discrete card the reverse holds. Taking the larger
 * gets both right without needing to know which kind of machine this is.
 *
 * @param {Object} memory
 * @param {number|null} [memory.vramTotalBytes] Dedicated video memory.
 * @param {number|null} [memory.gttTotalBytes] Graphics translation table memory.
 * @returns {number} Usable memory in MiB; 0 when nothing could be read.
 */
export function usableModelMemoryMb({ vramTotalBytes, gttTotalBytes } = {}) {
  const vram = Number(vramTotalBytes) || 0;
  const gtt = Number(gttTotalBytes) || 0;
  return Math.floor(Math.max(vram, gtt) / (1024 * 1024));
}

/**
 * Build the capability record a peer uses to decide what this node can run.
 *
 * @param {Object} options
 * @param {string[]} [options.vendors] PCI vendor ids present on this machine.
 * @param {number|null} [options.vramTotalBytes] Dedicated video memory.
 * @param {number|null} [options.gttTotalBytes] Graphics translation table memory.
 * @param {string[]} [options.engines] Engine backends this node can actually run.
 * @returns {{gpu:string, vram:number, engines:string}} The capability triple.
 */
export function capabilityFrom({ vendors, vramTotalBytes, gttTotalBytes, engines } = {}) {
  return {
    gpu: gpuVendorFrom(vendors),
    vram: usableModelMemoryMb({ vramTotalBytes, gttTotalBytes }),
    // Always a string, empty included: a peer must be able to tell "no engine
    // installed" apart from "this node did not say", and an omitted record
    // reads as the latter.
    engines: Array.isArray(engines) ? engines.join(',') : '',
  };
}

/**
 * Clip one TXT string to the single length byte the wire format gives it.
 *
 * A model id or an engine list can in principle run long, and an over-length
 * string is not a truncated record but a malformed one — avahi refuses the whole
 * service file, which takes the node off the fleet entirely.
 *
 * @param {string} entry A "key=value" string.
 * @returns {string} The entry, clipped to fit.
 */
function clipTxt(entry) {
  if (Buffer.byteLength(entry) <= MAX_TXT_BYTES) return entry;
  let clipped = entry;
  while (Buffer.byteLength(clipped) > MAX_TXT_BYTES) clipped = clipped.slice(0, -1);
  return clipped;
}

/**
 * Build the TXT records this node advertises.
 *
 * Every key is always present, empty where it has no value, so a peer can tell
 * "this node has no model loaded" from "this node did not tell me". Live detail
 * beyond this is fetched over HTTP once discovery has produced a host and port;
 * mDNS carries only what is needed to find a peer and triage it.
 *
 * @param {Object} state
 * @param {string} state.id Stable node id.
 * @param {string} state.name Node name.
 * @param {string} state.role Fleet role.
 * @param {string} state.engine Engine state.
 * @param {string|null} state.model Currently loaded model, if any.
 * @param {{gpu:string, vram:number, engines:string}} state.capability Capability.
 * @returns {string[]} TXT strings, ready to publish.
 */
export function advertisementTxt({ id, name, role, engine, model, capability } = {}) {
  const cap = capability || {};
  return [
    `v=${ADVERTISEMENT_VERSION}`,
    `id=${id ?? ''}`,
    `name=${name ?? ''}`,
    `role=${role ?? ''}`,
    `engine=${engine ?? ''}`,
    `model=${model ?? ''}`,
    `gpu=${cap.gpu ?? ''}`,
    `vram=${cap.vram ?? 0}`,
    `engines=${cap.engines ?? ''}`,
  ].map(clipTxt);
}

/**
 * Drop this node from a list of discovered peers.
 *
 * A node answers its own multicast query, so a raw browse always contains it.
 * Left in, a single appliance reports a fleet of two — which breaks the promise
 * that a node seeing no peers behaves exactly as it does today, and would give
 * Phase 2's designation a phantom to elect against.
 *
 * A node with no id of its own excludes nothing: dropping every peer because
 * this node could not read its machine id would be a worse failure than showing
 * one too many.
 *
 * @param {Array<{txt?: Object<string,string>}>} peers Discovered peers.
 * @param {string|null} selfId This node's id.
 * @returns {Array<Object>} Peers other than this node.
 */
export function excludeSelf(peers, selfId) {
  if (!Array.isArray(peers)) return [];
  if (!selfId) return peers;
  return peers.filter((peer) => peer?.txt?.id !== selfId);
}

/**
 * Escape text for inclusion in the service file.
 *
 * Node names come from an operator or from a language model, and model ids come
 * from a registry; any of them may contain a character XML cares about. A
 * service file avahi cannot parse is a node that silently vanishes from the
 * fleet, so this is escaped rather than trusted.
 *
 * @param {unknown} value Text to escape.
 * @returns {string} XML-safe text.
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the avahi service file that publishes this node to the fleet.
 *
 * The instance name is left as avahi's `%h` wildcard rather than baked in, so a
 * node that renames itself re-advertises under its new name with no rewrite
 * here — the hostname is already the one thing the identity step keeps correct.
 *
 * @param {Object} options
 * @param {number} options.port TCP port the manager's API answers on.
 * @param {string[]} options.txt TXT strings to publish.
 * @returns {string|null} The file's contents, or null when the port is unusable.
 */
export function buildServiceFile({ port, txt = [] } = {}) {
  const number = Number(port);
  // A service file with a broken port is one avahi rejects wholesale, which
  // takes this node off the fleet. Publishing nothing is the better failure.
  if (!Number.isInteger(number) || number < 1 || number > 65535) return null;

  const records = txt
    .map((entry) => `    <txt-record>${escapeXml(entry)}</txt-record>`)
    .join('\n');

  return `<?xml version="1.0" standalone="no"?><!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Written by Llama Manager. Edits are overwritten when the node's identity,
     role, or engine state changes. -->
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service>
    <type>_llama-manager._tcp</type>
    <port>${number}</port>
${records}
  </service>
</service-group>
`;
}
