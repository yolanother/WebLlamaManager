// Llama Manager — fleet advertisement tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies what an appliance tells the rest of the fleet about itself: that its
// node id is stable and does not leak the machine id it derives from, that the
// capability record answers "can this peer run the thing I want to give it"
// rather than merely listing models, and that the avahi service file produced is
// well-formed XML no matter what a model name or node name contains.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nodeIdFrom,
  gpuVendorFrom,
  usableModelMemoryMb,
  capabilityFrom,
  advertisementTxt,
  buildServiceFile,
  excludeSelf,
} from './fleet-advertisement.js';

// ── Node id ─────────────────────────────────────────────────────────────────

test('a node id is stable for the same machine', () => {
  assert.equal(nodeIdFrom('b3653f4f8c1d4a2e9f0a1b2c3d4e5f60'),
    nodeIdFrom('b3653f4f8c1d4a2e9f0a1b2c3d4e5f60'));
});

test('different machines get different node ids', () => {
  assert.notEqual(nodeIdFrom('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    nodeIdFrom('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
});

test('a node id never discloses the machine id it came from', () => {
  // systemd's machine-id is explicitly documented as a value to keep to
  // yourself; anything published on the link has to be a keyed hash of it.
  const machineId = 'b3653f4f8c1d4a2e9f0a1b2c3d4e5f60';
  const id = nodeIdFrom(machineId);
  assert.ok(!id.includes(machineId));
  assert.ok(!machineId.includes(id));
});

test('a node id is short enough to read off a screen', () => {
  const id = nodeIdFrom('b3653f4f8c1d4a2e9f0a1b2c3d4e5f60');
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('a missing or unreadable machine id yields no node id', () => {
  assert.equal(nodeIdFrom(''), null);
  assert.equal(nodeIdFrom(null), null);
  assert.equal(nodeIdFrom(undefined), null);
});

test('surrounding whitespace in the machine id file is ignored', () => {
  assert.equal(nodeIdFrom(' b3653f4f8c1d4a2e9f0a1b2c3d4e5f60\n'),
    nodeIdFrom('b3653f4f8c1d4a2e9f0a1b2c3d4e5f60'));
});

// ── Capability (open question O5) ────────────────────────────────────────────

test('PCI vendor ids map to the vendors a fleet can contain', () => {
  assert.equal(gpuVendorFrom(['0x1002']), 'amd');
  assert.equal(gpuVendorFrom(['0x10de']), 'nvidia');
  assert.equal(gpuVendorFrom(['0x8086']), 'intel');
});

test('an unknown or absent GPU is reported honestly, not guessed', () => {
  assert.equal(gpuVendorFrom([]), 'none');
  assert.equal(gpuVendorFrom(['0xbeef']), 'unknown');
  assert.equal(gpuVendorFrom(null), 'none');
});

test('a discrete card is preferred over the integrated one beside it', () => {
  // A workstation with an NVIDIA card also reports its Intel or AMD display
  // adapter. Advertising "intel" there would tell the fleet this box cannot run
  // anything, which is the opposite of true.
  assert.equal(gpuVendorFrom(['0x8086', '0x10de']), 'nvidia');
  assert.equal(gpuVendorFrom(['0x1002', '0x10de']), 'nvidia');
});

test('usable model memory on an APU is its GTT, not its tiny dedicated VRAM', () => {
  // The mixed-fleet trap this record exists to avoid. Strix Halo reports 1 GB of
  // dedicated VRAM and ~128 GB of GTT; a peer that believed the VRAM figure
  // would never be offered a model it can comfortably run.
  const mb = usableModelMemoryMb({
    vramTotalBytes: 1 * 1024 ** 3,
    gttTotalBytes: 128 * 1024 ** 3,
  });
  assert.equal(mb, 131072);
});

test('usable model memory on a discrete card is its VRAM', () => {
  const mb = usableModelMemoryMb({
    vramTotalBytes: 24 * 1024 ** 3,
    gttTotalBytes: 2 * 1024 ** 3,
  });
  assert.equal(mb, 24576);
});

test('unknown memory is reported as zero rather than invented', () => {
  assert.equal(usableModelMemoryMb({}), 0);
  assert.equal(usableModelMemoryMb({ vramTotalBytes: null, gttTotalBytes: null }), 0);
});

test('a capability record carries what a peer needs to place work', () => {
  const capability = capabilityFrom({
    vendors: ['0x1002'],
    vramTotalBytes: 1 * 1024 ** 3,
    gttTotalBytes: 128 * 1024 ** 3,
    engines: ['llama', 'ds4'],
  });
  assert.deepEqual(capability, { gpu: 'amd', vram: 131072, engines: 'llama,ds4' });
});

test('a node with no engine installed says so instead of omitting it', () => {
  // An absent engine list and an unread one must not look the same to a peer
  // deciding where to send work.
  const capability = capabilityFrom({ vendors: ['0x10de'], engines: [] });
  assert.equal(capability.engines, '');
  assert.equal(capability.gpu, 'nvidia');
});

// ── TXT records ─────────────────────────────────────────────────────────────

test('the advertisement carries identity, role, state and capability', () => {
  const txt = advertisementTxt({
    id: 'a1b2c3d4e5f60718',
    name: 'drakemore',
    role: 'standalone',
    engine: 'running',
    model: 'qwen3-coder-next',
    capability: { gpu: 'amd', vram: 131072, engines: 'llama' },
  });
  assert.deepEqual(txt, [
    'v=1',
    'id=a1b2c3d4e5f60718',
    'name=drakemore',
    'role=standalone',
    'pin=',
    'engine=running',
    'model=qwen3-coder-next',
    'gpu=amd',
    'vram=131072',
    'engines=llama',
  ]);
});

test('a node with nothing loaded advertises an empty model, not a stale one', () => {
  const txt = advertisementTxt({
    id: 'a1b2c3d4e5f60718',
    name: 'drakemore',
    role: 'standalone',
    engine: 'idle',
    model: null,
    capability: { gpu: 'amd', vram: 131072, engines: 'llama' },
  });
  assert.ok(txt.includes('model='));
  assert.ok(txt.includes('engine=idle'));
});

test('every TXT string stays inside the one-byte length the wire format allows', () => {
  const txt = advertisementTxt({
    id: 'a1b2c3d4e5f60718',
    name: 'x'.repeat(24),
    role: 'standalone',
    engine: 'running',
    model: 'y'.repeat(400),
    capability: { gpu: 'amd', vram: 131072, engines: 'z'.repeat(400) },
  });
  for (const entry of txt) {
    assert.ok(Buffer.byteLength(entry) <= 255, `too long: ${entry.slice(0, 40)}…`);
  }
});

test('the advertisement carries the operator pin so the fleet can see it', () => {
  // The pin is how a choice made on ONE node's screen reaches every other node.
  // There is no other channel: a pin that is stored but not advertised leaves
  // the rest of the fleet electing around the operator's decision.
  const txt = advertisementTxt({
    id: 'a1', name: 'n', role: 'main', pin: '1', engine: 'idle', model: null,
    capability: { gpu: 'amd', vram: 1, engines: 'llama' },
  });
  assert.ok(txt.includes('pin=1'));
  assert.ok(txt.includes('role=main'));
});

test('an unpinned node advertises an empty pin rather than omitting it', () => {
  const txt = advertisementTxt({
    id: 'a1', name: 'n', role: 'secondary', engine: 'idle', model: null,
    capability: { gpu: 'amd', vram: 1, engines: 'llama' },
  });
  assert.ok(txt.includes('pin='));
  assert.ok(!txt.includes('pin=1'));
});

// ── Service file ────────────────────────────────────────────────────────────

test('the service file advertises the federation type on the API port', () => {
  const xml = buildServiceFile({ port: 3001, txt: ['v=1'] });
  assert.match(xml, /<type>_llama-manager\._tcp<\/type>/);
  assert.match(xml, /<port>3001<\/port>/);
  assert.match(xml, /<txt-record>v=1<\/txt-record>/);
});

test('the instance name follows the hostname rather than being baked in', () => {
  // avahi substitutes %h at publication time, so a node that renames itself
  // re-advertises under the new name with no rewrite of this file.
  const xml = buildServiceFile({ port: 3001, txt: [] });
  assert.match(xml, /<name replace-wildcards="yes">%h<\/name>/);
});

test('the service file is the DTD avahi expects', () => {
  const xml = buildServiceFile({ port: 3001, txt: [] });
  assert.match(xml, /^<\?xml version="1\.0" standalone="no"\?>/);
  assert.match(xml, /<!DOCTYPE service-group SYSTEM "avahi-service\.dtd">/);
});

test('a model name full of markup cannot break the service file', () => {
  // Model ids come from a registry and a node name comes from an operator or a
  // language model. Either can contain a character XML cares about, and a
  // service file avahi cannot parse means the node vanishes from the fleet.
  const xml = buildServiceFile({
    port: 3001,
    txt: advertisementTxt({
      id: 'a1',
      name: 'a&b',
      role: 'standalone',
      engine: 'running',
      model: '</service><evil>&"\'',
      capability: { gpu: 'amd', vram: 1, engines: '<x>' },
    }),
  });
  assert.ok(!xml.includes('<evil>'));
  assert.equal((xml.match(/<\/service>/g) || []).length, 1);
  assert.ok(xml.includes('&amp;'));
  assert.ok(xml.includes('&lt;'));
});

test('a port that is not a usable number is refused rather than published', () => {
  // A service file with a broken port is one avahi rejects wholesale, taking
  // the node off the fleet. Better to not write one.
  assert.equal(buildServiceFile({ port: 0, txt: [] }), null);
  assert.equal(buildServiceFile({ port: 'http', txt: [] }), null);
  assert.equal(buildServiceFile({ port: 99999, txt: [] }), null);
  assert.equal(buildServiceFile({ txt: [] }), null);
});

// ── Seeing yourself ─────────────────────────────────────────────────────────

test('a node does not report itself as a peer', () => {
  // A node answers its own multicast query, so the raw browse always contains
  // it. Left in, a single appliance looks like a fleet of two -- which is the
  // one thing Phase 1 must not do, since a lone node has to behave exactly as it
  // does today and Phase 2's designation counts what discovery reports.
  const peers = [
    { instance: 'drakemore-llama-manager', txt: { id: 'b839de3c576f07b6' } },
    { instance: 'ashfall-llama-manager', txt: { id: '0123456789abcdef' } },
  ];
  assert.deepEqual(
    excludeSelf(peers, 'b839de3c576f07b6').map((p) => p.instance),
    ['ashfall-llama-manager'],
  );
});

test('an alone node sees an empty fleet', () => {
  const peers = [{ instance: 'drakemore-llama-manager', txt: { id: 'abc' } }];
  assert.deepEqual(excludeSelf(peers, 'abc'), []);
});

test('peers are kept when this node has no id of its own to compare', () => {
  // No machine id means no node id. Dropping every peer would be worse than
  // showing one too many, so an unknown self excludes nothing.
  const peers = [{ instance: 'ashfall-llama-manager', txt: { id: 'abc' } }];
  assert.equal(excludeSelf(peers, null).length, 1);
});

test('a peer that advertises no id is still reported', () => {
  const peers = [{ instance: 'ashfall-llama-manager', txt: {} }];
  assert.equal(excludeSelf(peers, 'abc').length, 1);
});
