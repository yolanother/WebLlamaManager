// Llama Manager — mDNS service discovery for appliance federation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Finds the other Llama Manager appliances on the local link by asking for the
// `_llama-manager._tcp` DNS-SD service and reading the replies, so a fleet
// assembles itself with no registry, no broker, and no bootstrap address typed
// anywhere. It speaks the mDNS wire format directly over an ephemeral UDP port
// rather than shelling out, because the appliance image ships avahi-daemon but
// none of avahi-utils — there is no `avahi-browse` to call — and because owning
// the socket is what lets discovery coexist with the avahi already holding port
// 5353. Queries set the unicast-response bit so peers answer this port directly.
//
// Parsing is the module's real work and every byte of it comes from the link,
// so it is written as a trust boundary: bounds are checked before every read,
// compression pointers may only point backwards, and any packet that is
// truncated, oversized, or hostile yields no peers instead of a throw or a hang.
// Browsing likewise resolves to an empty list when the network is unusable — a
// node that sees no peers is a fleet of one, which is a fully working appliance
// and never an error the caller has to handle.

import dgram from 'node:dgram';

/**
 * DNS-SD service type every Llama Manager appliance advertises itself under.
 * @type {string}
 */
export const SERVICE_TYPE = '_llama-manager._tcp';

/** Link-local multicast group and port that mDNS runs on (RFC 6762). */
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

/** Resource record types this module reads. */
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;

/**
 * Longest chain of compression pointers followed before a name is abandoned.
 * Pointers must already point strictly backwards, so this only bounds a packet
 * built from many tiny legal hops.
 */
const MAX_POINTER_HOPS = 64;

/**
 * How long a browse listens for answers before reporting what it heard.
 * Comfortably longer than a link-local round trip and short enough that a UI
 * asking "who else is here" does not feel stalled.
 */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Encode a DNS name as the length-prefixed labels the wire format uses.
 *
 * @param {string} name Dotted name, e.g. "_llama-manager._tcp.local".
 * @returns {Buffer} The encoded name including its terminating root label.
 */
function encodeName(name) {
  const parts = [];
  for (const label of String(name).split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * Build the one-shot query that asks the link who offers a service.
 *
 * The unicast-response bit is set on the question class deliberately: it asks
 * responders to reply straight to this socket's ephemeral port rather than to
 * the multicast group, which is what lets the manager browse at all while
 * avahi-daemon holds 5353 for itself.
 *
 * @param {string} name Fully qualified service name to ask about.
 * @returns {Buffer} A complete DNS query packet.
 */
export function encodeQuery(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT; every other count stays zero.
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_PTR, 0);
  question.writeUInt16BE(0x8001, 2); // QU bit | class IN
  return Buffer.concat([header, encodeName(name), question]);
}

/**
 * Read a possibly compressed DNS name.
 *
 * Compression pointers are required to point strictly backwards. That is true
 * of every legal packet and it is also the whole loop guard: a pointer that
 * pointed forwards or at itself could be chased forever, and this parser runs on
 * packets any machine on the link can send.
 *
 * @param {Buffer} buf Whole packet, since pointers are absolute offsets into it.
 * @param {number} offset Where the name starts.
 * @returns {{name: string, end: number}|null} The name and the offset just past
 *   it in the record stream, or null when the encoding is unusable.
 */
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = -1;
  let hops = 0;

  while (pos >= 0 && pos < buf.length) {
    const length = buf[pos];

    if (length === 0) {
      if (end < 0) end = pos + 1;
      return { name: labels.join('.'), end };
    }

    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      const target = ((length & 0x3f) << 8) | buf[pos + 1];
      // Only the first pointer advances the record stream; the rest are detours.
      if (end < 0) end = pos + 2;
      if (target >= pos) return null;
      if ((hops += 1) > MAX_POINTER_HOPS) return null;
      pos = target;
      continue;
    }

    const start = pos + 1;
    if (length > 63 || start + length > buf.length) return null;
    labels.push(buf.subarray(start, start + length).toString('ascii'));
    pos = start + length;
  }

  return null;
}

/**
 * Turn DNS-SD TXT strings into the key/value map they represent.
 *
 * Only the first `=` separates a key from its value, so a value may contain
 * one. A string with no `=` is a key that is present with an empty value, which
 * is how DNS-SD spells a boolean flag.
 *
 * @param {string[]} strings Raw TXT strings.
 * @returns {Object<string,string>} Decoded records.
 */
export function parseTxt(strings) {
  const txt = {};
  for (const entry of strings) {
    if (typeof entry !== 'string' || !entry) continue;
    const split = entry.indexOf('=');
    if (split < 0) txt[entry] = '';
    else txt[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return txt;
}

/**
 * Decode a TXT record's payload, which is a run of length-prefixed strings.
 *
 * @param {Buffer} buf Whole packet.
 * @param {number} offset Start of the record data.
 * @param {number} length Record data length.
 * @returns {Object<string,string>} Decoded key/value pairs.
 */
function readTxt(buf, offset, length) {
  const strings = [];
  let pos = offset;
  const end = offset + length;
  while (pos < end) {
    const size = buf[pos];
    if (pos + 1 + size > end) break;
    strings.push(buf.subarray(pos + 1, pos + 1 + size).toString('utf8'));
    pos += 1 + size;
  }
  return parseTxt(strings);
}

/**
 * Render 16 bytes as an IPv6 address.
 *
 * Leading zeros are stripped per group but runs of zero groups are not folded
 * into `::`. The result is only ever shown to a human or logged — peers are
 * contacted over IPv4 — so a longer spelling of a correct address is fine and a
 * zero-run compressor is code with no reader.
 *
 * @param {Buffer} bytes The 16 address bytes.
 * @returns {string} Colon-separated address.
 */
function formatIpv6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

/**
 * Decode one record's payload according to its type.
 *
 * @param {Buffer} buf Whole packet.
 * @param {number} offset Start of the record data.
 * @param {number} length Record data length.
 * @param {number} type Record type.
 * @returns {*} Type-specific data, or null when it cannot be read.
 */
function readRdata(buf, offset, length, type) {
  switch (type) {
    case TYPE_A:
      return length === 4 ? Array.from(buf.subarray(offset, offset + 4)).join('.') : null;
    case TYPE_AAAA:
      return length === 16 ? formatIpv6(buf.subarray(offset, offset + 16)) : null;
    case TYPE_PTR:
      return readName(buf, offset)?.name ?? null;
    case TYPE_TXT:
      return readTxt(buf, offset, length);
    case TYPE_SRV: {
      if (length < 7) return null;
      const target = readName(buf, offset + 6);
      if (!target) return null;
      return { port: buf.readUInt16BE(offset + 4), target: target.name };
    }
    default:
      return null;
  }
}

/**
 * Decode an mDNS response into its records.
 *
 * Answer, authority, and additional records are read into one list because a
 * DNS-SD responder is free to place the SRV, TXT, and address records that
 * complete a service either in the answer section or as additional records, and
 * a browser that only reads one of them sees half a peer. Decoding stops at the
 * first unreadable record and returns what was understood up to that point,
 * which keeps a peer that answered correctly usable even when something later in
 * the packet is not.
 *
 * @param {Buffer} buf A received datagram.
 * @returns {{answers: Array<{name:string, type:number, class:number, ttl:number,
 *   data:*}>}} Decoded records; empty when nothing could be read.
 */
export function decodeMessage(buf) {
  const empty = { answers: [] };
  if (!Buffer.isBuffer(buf) || buf.length < 12) return empty;

  const questions = buf.readUInt16BE(4);
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);

  let pos = 12;
  for (let i = 0; i < questions; i += 1) {
    const name = readName(buf, pos);
    if (!name) return empty;
    pos = name.end + 4;
  }

  const answers = [];
  for (let i = 0; i < records; i += 1) {
    const name = readName(buf, pos);
    if (!name) break;
    pos = name.end;
    if (pos + 10 > buf.length) break;

    const type = buf.readUInt16BE(pos);
    const klass = buf.readUInt16BE(pos + 2);
    const ttl = buf.readUInt32BE(pos + 4);
    const length = buf.readUInt16BE(pos + 8);
    pos += 10;
    // A record claiming more data than the packet holds is the classic
    // malformed-packet read primitive; stop rather than clamp, because the
    // records after it cannot be located either.
    if (pos + length > buf.length) break;

    answers.push({
      name: name.name,
      type,
      class: klass & 0x7fff,
      ttl,
      data: readRdata(buf, pos, length, type),
    });
    pos += length;
  }

  return { answers };
}

/**
 * Assemble the peers a response describes.
 *
 * A peer is only reported when the packet carries enough to actually reach it —
 * a service instance, and an SRV record giving a port. IPv4 is preferred over
 * IPv6 because a link-local v6 address cannot be dialled over HTTP without a
 * scope id, and the appliance answers on v4 regardless.
 *
 * @param {Buffer} buf A received datagram.
 * @param {string} [serviceType] Service type to assemble peers for.
 * @returns {Array<{instance:string, host:string, port:number, address:string|null,
 *   addresses:string[], txt:Object<string,string>}>} Peers found in the packet.
 */
export function peersFromMessage(buf, serviceType = SERVICE_TYPE) {
  const { answers } = decodeMessage(buf);
  if (!answers.length) return [];

  const suffix = `.${serviceType}.local`;
  const peers = [];

  for (const record of answers) {
    if (record.type !== TYPE_PTR) continue;
    if (record.name !== `${serviceType}.local`) continue;
    const instance = record.data;
    if (typeof instance !== 'string' || !instance.endsWith(suffix)) continue;

    const srv = answers.find((r) => r.type === TYPE_SRV && r.name === instance);
    if (!srv?.data) continue;
    const txt = answers.find((r) => r.type === TYPE_TXT && r.name === instance);

    const addresses = answers
      .filter((r) => (r.type === TYPE_A || r.type === TYPE_AAAA) && r.name === srv.data.target)
      .map((r) => r.data)
      .filter(Boolean);
    const ipv4 = answers.find((r) => r.type === TYPE_A && r.name === srv.data.target);

    peers.push({
      instance: instance.slice(0, -suffix.length),
      host: srv.data.target,
      port: srv.data.port,
      address: ipv4?.data ?? addresses[0] ?? null,
      addresses,
      txt: txt?.data ?? {},
    });
  }

  return peers;
}

/**
 * Ask the local link which appliances are present.
 *
 * Resolves to the peers that answered within the timeout. Every failure — no
 * permission to open a socket, no network, a peer talking nonsense — resolves to
 * a shorter list rather than rejecting, because "nobody answered" and "a fleet
 * of one" are the same working state and the caller has nothing different to do
 * about either.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] How long to listen for answers.
 * @param {string} [options.serviceType] Service type to browse for.
 * @param {() => Object} [options.createSocket] Datagram socket factory, injected
 *   by tests so browsing can be exercised without a network.
 * @returns {Promise<Array<Object>>} Discovered peers, deduplicated by node id.
 */
export function browse({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  serviceType = SERVICE_TYPE,
  createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
} = {}) {
  let socket;
  try {
    socket = createSocket();
  } catch {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    const found = new Map();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', finish);
    socket.on('message', (message) => {
      for (const peer of peersFromMessage(message, serviceType)) {
        // Keyed on the node id, not the name: a node renames itself, and the
        // bootstrap collision suffix means two fresh boxes can briefly disagree
        // about who is called what. The id is the thing that does not move.
        found.set(peer.txt.id || peer.instance, peer);
      }
    });

    // ponytail: relies on peers honouring the unicast-response bit, which avahi
    // does — verified against the appliance. A responder that multicast its
    // answer instead would be missed; joining the group would need a shared bind
    // on 5353 alongside avahi, which is worth doing only if such a peer appears.
    socket.bind({ port: 0 }, () => {
      try {
        socket.setMulticastTTL(255);
        socket.send(encodeQuery(`${serviceType}.local`), MDNS_PORT, MDNS_ADDRESS, (error) => {
          if (error) finish();
        });
      } catch {
        finish();
      }
    });
  });
}
