#!/usr/bin/env node
// Llama Manager — privileged system-health snapshot writer.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Runs as root on a systemd timer and writes ONE world-readable JSON snapshot
// describing storage health: per-drive SMART fields, counts of the kernel
// signals that precede a storage lockup, and the cause of the most recent kernel
// panic read out of pstore. The API server reads this file and never runs
// privileged code or subprocesses of its own.
//
// WHY A PRIVILEGED HELPER AT ALL
// Three inputs are root-only on this platform and there is no group shortcut:
//   * /dev/nvme* is `crw------- root root`, so SMART needs real root.
//   * /dev/kmsg needs CAP_SYSLOG because kernel.dmesg_restrict=1.
//   * /var/lib/systemd/pstore is mode 600 root.
// Collecting them here keeps the web-facing process unprivileged and keeps a
// hung `nvme` call — entirely possible on a drive that is in the act of failing
// — out of the request path.
//
// All parsing is delegated to `api/drive-health.js` so the helper and the API
// share one source of truth. This file only does I/O.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSmartLog, parseKmsgFaults, attributePanic } from '../api/drive-health.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.HEALTH_SNAPSHOT_PATH || '/run/llama-manager/health-snapshot.json';
const PSTORE = process.env.HEALTH_PSTORE_DIR || '/var/lib/systemd/pstore';
/** Cap on kernel-log bytes pulled from the ring buffer, to bound runtime and output. */
const KMSG_LIMIT = 1 << 20;

/** Read a sysfs attribute, trimmed; null when absent or unreadable. */
function sysfs(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

/**
 * Enumerate NVMe controllers with their stable identity.
 *
 * Identity comes from sysfs rather than the node name on purpose: nvmeXnY
 * numbering is NOT stable across boots on this box (the same physical SPCC has
 * appeared as both nvme0n1 and nvme1n1), so a drive must be recognized by model
 * and serial or history gets attributed to the wrong device.
 *
 * @returns {Array<{name:string, model:string|null, serial:string|null, firmware:string|null}>}
 */
function controllers() {
  let names = [];
  try {
    names = fs.readdirSync('/sys/class/nvme').filter((n) => /^nvme\d+$/.test(n)).sort();
  } catch { return []; }
  return names.map((name) => ({
    name,
    model: sysfs(`/sys/class/nvme/${name}/model`),
    serial: sysfs(`/sys/class/nvme/${name}/serial`),
    firmware: sysfs(`/sys/class/nvme/${name}/firmware_rev`),
  }));
}

/**
 * Capture `nvme smart-log` for one controller.
 *
 * Returns null — not a throw and not a zeroed record — when nvme-cli is missing
 * or the call fails. A drive that cannot be read is unknown, and the panel is
 * required to render that as unknown rather than as healthy.
 *
 * @param {string} name Controller name, e.g. `nvme1`.
 * @returns {string|null} Raw smart-log text, or null.
 */
function smartLog(name) {
  try {
    return execFileSync('nvme', ['smart-log', `/dev/${name}`], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; }
}

/**
 * Drain the kernel ring buffer without blocking.
 *
 * /dev/kmsg hands back one record per read and then blocks waiting for the next
 * one, so it must be opened non-blocking and read until EAGAIN. This is the only
 * place the fatal window is ever visible live: journald cannot record a storage
 * controller dying, because journald is writing to the disk that is vanishing.
 *
 * @returns {string} Ring-buffer text, capped at KMSG_LIMIT bytes.
 */
function readKmsg() {
  let fd;
  try {
    fd = fs.openSync('/dev/kmsg', fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch { return ''; }
  const chunks = [];
  const buf = Buffer.alloc(8192);
  let total = 0;
  try {
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (err) {
        // EAGAIN: caught up with the buffer. EPIPE: records were overwritten
        // while we read, which is normal under load — keep what we have.
        if (err.code === 'EAGAIN' || err.code === 'EPIPE') break;
        throw err;
      }
      if (!n) break;
      chunks.push(buf.toString('utf8', 0, n));
      total += n;
      if (total >= KMSG_LIMIT) break;
    }
  } catch { /* fall through with whatever was captured */ } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
  return chunks.join('');
}

/**
 * Find the newest pstore panic dump and read its text.
 *
 * Directory names are the panic epoch. The record subdirectory is NOT always
 * `001` — observed `002` on two dumps — so it is globbed rather than assumed.
 * Most retained dumps on this box are empty shells, so an entry with no readable
 * records is reported with null text and left for `attributePanic` to call
 * unknown.
 *
 * @returns {{epoch:number, isoTime:string, text:string|null}|null}
 */
function newestPanic() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PSTORE).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a));
  } catch { return null; }
  if (!dirs.length) return null;
  const epoch = Number(dirs[0]);
  const base = path.join(PSTORE, dirs[0]);
  let text = null;
  try {
    for (const sub of fs.readdirSync(base)) {
      const subdir = path.join(base, sub);
      let files;
      try { files = fs.readdirSync(subdir); } catch { continue; }
      // Prefer the reassembled dmesg.txt; otherwise concatenate the raw records,
      // which arrive as ...NNNNN suffixed parts that sort into reading order.
      if (files.includes('dmesg.txt')) {
        text = fs.readFileSync(path.join(subdir, 'dmesg.txt'), 'utf8');
        break;
      }
      const parts = files.filter((f) => f.startsWith('dmesg-')).sort();
      if (parts.length) {
        text = parts.map((f) => fs.readFileSync(path.join(subdir, f), 'utf8')).join('\n');
        break;
      }
    }
  } catch { /* unreadable dump — reported as null text */ }
  return { epoch, isoTime: new Date(epoch * 1000).toISOString(), text };
}

/** Build the full snapshot object. */
function collect() {
  const drives = controllers().map((c) => {
    const raw = smartLog(c.name);
    return { ...c, smartAvailable: raw !== null, ...(raw ? parseSmartLog(raw) : parseSmartLog('')) };
  });
  const panic = newestPanic();
  return {
    generatedAt: new Date().toISOString(),
    nvmeCliAvailable: drives.some((d) => d.smartAvailable),
    drives,
    faults: parseKmsgFaults(readKmsg()),
    lastPanic: panic
      ? { epoch: panic.epoch, isoTime: panic.isoTime, ...attributePanic(panic.text || ''), hasDump: panic.text !== null }
      : null,
  };
}

/**
 * Write the snapshot atomically.
 *
 * Temp file plus rename, so a reader polling this path can never observe a
 * half-written document. Mode 0644 because the whole point is that the
 * unprivileged API can read it.
 */
function main() {
  const snapshot = collect();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, OUT);
  if (process.argv.includes('--print')) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

main();
export { collect, HERE };
