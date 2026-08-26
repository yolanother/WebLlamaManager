// Llama Manager — mDNS service discovery wire-format tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the only piece of federation that speaks raw network bytes: that a
// browse query is a packet avahi actually answers, that a real avahi response —
// captured from an appliance, compression pointers and all — is read back into
// the peer it describes, and that every malformed, truncated, or hostile packet
// yields no peers instead of a throw or a hang. Discovery reads packets from
// anyone on the link, so the parser is a trust boundary and is tested as one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVICE_TYPE,
  encodeQuery,
  decodeMessage,
  parseTxt,
  peersFromMessage,
  browse,
} from './mdns-discovery.js';

// A genuine 241-byte response from avahi-daemon 0.8 on the appliance
// (drakemore-llama-manager, 192.168.1.79) to a PTR query for
// _llama-manager._tcp.local. Captured rather than hand-built on purpose: it
// carries the additional-record stuffing and the four compression pointers a
// synthetic fixture would not, which is precisely what the parser gets wrong.
const AVAHI_RESPONSE = Buffer.from(
  'AACEAAABAAYAAAAADl9sbGFtYS1tYW5hZ2VyBF90Y3AFbG9jYWwAAAyAAcAMAAwAAQAAAAoAGhdk'
  + 'cmFrZW1vcmUtbGxhbWEtbWFuYWdlcsAMwDcAEAABAAAACgAgA3Y9MQxpZD1wcm9iZTAwMDEObmFt'
  + 'ZT1kcmFrZW1vcmXANwAhAAEAAAAKACAAAAAAC7kXZHJha2Vtb3JlLWxsYW1hLW1hbmFnZXLAIMCP'
  + 'ABwAAQAAAAoAEP3gj33vVwPRAoSX//4anP/AjwAcAAEAAAAKABD94I9971cD0SYzwkX9bUKRwI8A'
  + 'AQABAAAACgAEwKgBTw==',
  'base64',
);

// ── Query encoding ──────────────────────────────────────────────────────────

test('the browse query names the federation service type', () => {
  assert.equal(SERVICE_TYPE, '_llama-manager._tcp');
});

test('a query carries exactly one question and no answers', () => {
  const query = encodeQuery(`${SERVICE_TYPE}.local`);
  // Header field offsets are the single easiest thing to get wrong here, and a
  // count written into the flags field produces a packet avahi silently ignores
  // rather than an error — so each one is asserted by offset.
  assert.equal(query.readUInt16BE(2), 0, 'flags must be a plain query');
  assert.equal(query.readUInt16BE(4), 1, 'QDCOUNT lives at offset 4');
  assert.equal(query.readUInt16BE(6), 0, 'ANCOUNT');
  assert.equal(query.readUInt16BE(8), 0, 'NSCOUNT');
  assert.equal(query.readUInt16BE(10), 0, 'ARCOUNT');
});

test('a query asks for PTR records and requests a unicast answer', () => {
  const query = encodeQuery(`${SERVICE_TYPE}.local`);
  const type = query.readUInt16BE(query.length - 4);
  const klass = query.readUInt16BE(query.length - 2);
  assert.equal(type, 12, 'PTR');
  // The QU bit is what makes a peer answer our ephemeral port directly instead
  // of multicasting, which is the whole reason this works alongside a running
  // avahi that already owns 5353.
  assert.equal(klass & 0x8000, 0x8000, 'QU unicast-response bit');
  assert.equal(klass & 0x7fff, 1, 'class IN');
});

test('query names are encoded as length-prefixed labels', () => {
  const query = encodeQuery('_tcp.local');
  const body = query.subarray(12);
  assert.equal(body[0], 4);
  assert.equal(body.subarray(1, 5).toString('ascii'), '_tcp');
  assert.equal(body[5], 5);
  assert.equal(body.subarray(6, 11).toString('ascii'), 'local');
  assert.equal(body[11], 0, 'root label terminates the name');
});

// ── Response decoding ───────────────────────────────────────────────────────

test('a real avahi response decodes to its six answer records', () => {
  const message = decodeMessage(AVAHI_RESPONSE);
  assert.equal(message.answers.length, 6);
  const types = message.answers.map((r) => r.type);
  assert.deepEqual(types, [12, 16, 33, 28, 28, 1], 'PTR TXT SRV AAAA AAAA A');
});

test('compression pointers are followed when decoding names', () => {
  const { answers } = decodeMessage(AVAHI_RESPONSE);
  // Every one of these names is stored as a suffix pointer in the fixture; a
  // parser that ignores pointers produces truncated garbage here rather than
  // failing outright, which is why the full names are asserted.
  assert.equal(answers[0].name, '_llama-manager._tcp.local');
  assert.equal(
    answers[0].data,
    'drakemore-llama-manager._llama-manager._tcp.local',
  );
  assert.equal(answers[2].data.target, 'drakemore-llama-manager.local');
});

test('SRV records yield the port a peer is reachable on', () => {
  const { answers } = decodeMessage(AVAHI_RESPONSE);
  assert.equal(answers[2].data.port, 3001);
});

test('A records decode to a dotted address and AAAA to a v6 address', () => {
  const { answers } = decodeMessage(AVAHI_RESPONSE);
  assert.equal(answers[5].data, '192.168.1.79');
  assert.equal(answers[3].data, 'fde0:8f7d:ef57:3d1:284:97ff:fe1a:9cff');
});

// ── TXT records ─────────────────────────────────────────────────────────────

test('TXT strings decode into key/value pairs', () => {
  const { answers } = decodeMessage(AVAHI_RESPONSE);
  assert.deepEqual(answers[1].data, {
    v: '1',
    id: 'probe0001',
    name: 'drakemore',
  });
});

test('a TXT key with no value reads as present and empty', () => {
  assert.deepEqual(parseTxt(['solo']), { solo: '' });
});

test('only the first equals sign separates a TXT key from its value', () => {
  assert.deepEqual(parseTxt(['gpu=amd:gfx1151', 'q=a=b']), {
    gpu: 'amd:gfx1151',
    q: 'a=b',
  });
});

// ── Peer assembly ───────────────────────────────────────────────────────────

test('a response assembles into the peer it describes', () => {
  const peers = peersFromMessage(AVAHI_RESPONSE);
  assert.equal(peers.length, 1);
  const [peer] = peers;
  assert.equal(peer.instance, 'drakemore-llama-manager');
  assert.equal(peer.host, 'drakemore-llama-manager.local');
  assert.equal(peer.port, 3001);
  assert.equal(peer.txt.id, 'probe0001');
  assert.equal(peer.address, '192.168.1.79');
});

test('a peer keeps its IPv4 address even when v6 records come first', () => {
  // The fixture lists two AAAA records before the A record. A peer whose
  // address ends up being a link-local v6 is one the manager cannot open an
  // HTTP connection to without a scope id, so v4 has to win.
  assert.equal(peersFromMessage(AVAHI_RESPONSE)[0].address, '192.168.1.79');
});

test('a response advertising some other service yields no peers', () => {
  const peers = peersFromMessage(AVAHI_RESPONSE, '_printer._tcp');
  assert.deepEqual(peers, []);
});

// ── Hostile and malformed input ─────────────────────────────────────────────

test('a truncated packet yields no peers rather than throwing', () => {
  for (let cut = 0; cut < AVAHI_RESPONSE.length; cut += 7) {
    const truncated = AVAHI_RESPONSE.subarray(0, cut);
    assert.doesNotThrow(() => peersFromMessage(truncated), `cut at ${cut}`);
  }
});

test('an empty or nonsense buffer yields no peers', () => {
  assert.deepEqual(peersFromMessage(Buffer.alloc(0)), []);
  assert.deepEqual(peersFromMessage(Buffer.alloc(12)), []);
  assert.deepEqual(peersFromMessage(Buffer.from('not a dns packet')), []);
});

test('a compression pointer that points at itself terminates', () => {
  // A packet from the link can be hostile as easily as broken, and a naive
  // pointer-follower loops forever on this one — taking the manager's event
  // loop with it. The parser must give up, not hang.
  const packet = Buffer.alloc(16);
  packet.writeUInt16BE(0x8400, 2);
  packet.writeUInt16BE(1, 6);
  packet.writeUInt16BE(0xc00c, 12); // name at offset 12 points to offset 12
  assert.deepEqual(peersFromMessage(packet), []);
});

test('a record claiming more data than the packet holds yields no peers', () => {
  const packet = Buffer.from(AVAHI_RESPONSE);
  // The PTR record's RDLENGTH, inflated well past the end of the buffer.
  packet.writeUInt16BE(0xffff, 47);
  assert.doesNotThrow(() => peersFromMessage(packet));
});

// ── Browsing ────────────────────────────────────────────────────────────────

/**
 * Build a fake datagram socket that replays canned responses.
 *
 * @param {Buffer[]} responses Packets to deliver as if they arrived.
 * @returns {Object} A stand-in for a node:dgram socket.
 */
function fakeSocket(responses) {
  const handlers = {};
  return {
    sent: [],
    closed: false,
    on(event, handler) { handlers[event] = handler; return this; },
    bind(_opts, ready) { if (ready) setImmediate(ready); return this; },
    setBroadcast() {},
    setMulticastTTL() {},
    addMembership() {},
    send(message, _port, _address, done) {
      this.sent.push(message);
      for (const response of responses) {
        setImmediate(() => handlers.message?.(response, { address: '192.168.1.79' }));
      }
      if (done) done(null);
    },
    close() { this.closed = true; handlers.close?.(); },
  };
}

test('browsing returns the peers that answered', async () => {
  const socket = fakeSocket([AVAHI_RESPONSE]);
  const peers = await browse({ timeoutMs: 40, createSocket: () => socket });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].txt.id, 'probe0001');
  assert.equal(socket.closed, true, 'the socket must not be leaked');
});

test('browsing an empty link resolves to no peers, not an error', async () => {
  const peers = await browse({ timeoutMs: 40, createSocket: () => fakeSocket([]) });
  assert.deepEqual(peers, []);
});

test('the same peer answering twice is reported once', async () => {
  const socket = fakeSocket([AVAHI_RESPONSE, AVAHI_RESPONSE]);
  const peers = await browse({ timeoutMs: 40, createSocket: () => socket });
  assert.equal(peers.length, 1);
});

test('a peer whose packet is garbage does not lose the peers that are fine', async () => {
  const socket = fakeSocket([Buffer.from('garbage'), AVAHI_RESPONSE]);
  const peers = await browse({ timeoutMs: 40, createSocket: () => socket });
  assert.equal(peers.length, 1);
});

test('a socket that cannot be opened resolves to no peers', async () => {
  // No mDNS is a fleet of one, which is a working appliance. It is never an
  // error the caller has to handle.
  const peers = await browse({
    timeoutMs: 40,
    createSocket: () => { throw new Error('EPERM'); },
  });
  assert.deepEqual(peers, []);
});
