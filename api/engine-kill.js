// Llama Manager — robust host-PID kill helper for supervised inference engines.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, injectable logic for reclaiming a stuck inference-engine process by its HOST
// PID rather than relying on an in-container `pkill` that wedges under load. distrobox
// shares the host PID namespace, so a host `kill -9` reaches the container's
// llama-server / ds4-server workers directly and never touches the podman layer (which
// is what piled up D-state execs and froze the box). killEngineByComm() enumerates the
// pids whose /proc comm EXACTLY equals the target engine (never cross-matching the other
// engine), SIGKILLs them, re-signals any survivors each poll, and waits — bounded — until
// they are gone, so it can never "time out and give up" while a 60GB model is still
// resident. A pid that persists past the timeout (uninterruptible D-state — the documented
// wedged-GPU precursor) is reported back via { ok:false, remainingPids } so the caller can
// refuse to spawn a second engine on top of it. All I/O (the /proc read, the kill syscall,
// the clock/sleep) is injected so the state machine is deterministically unit-testable
// without real processes.

/**
 * PIDs in a proc table whose comm EXACTLY equals `comm` (trailing /proc newline trimmed).
 * The exact-match is what guarantees a llama-server reclaim never signals ds4-server and
 * vice-versa.
 * @param {Array<{pid:number, comm:string}>} procTable Rows from a host /proc scan.
 * @param {string} comm Target engine comm ('llama-server' | 'ds4-server').
 * @returns {number[]} Matching pids, in table order.
 */
export function enginePids(procTable, comm) {
  const target = String(comm || '').trim();
  if (!target) return [];
  return (procTable || [])
    .filter((r) => r && String(r.comm || '').trim() === target)
    .map((r) => r.pid);
}

/**
 * SIGKILL every host process whose comm equals `comm`, then poll until they are all gone
 * or the timeout elapses. Survivors are re-signalled on each poll (a slow-to-die process
 * gets another SIGKILL) so a transiently-busy process is not abandoned early. The helper
 * NEVER matches the other engine's comm. Resolves to { ok:false, remainingPids } when a pid
 * survives the whole window — the caller must treat that as a wedged/D-state process and
 * refuse to spawn a second engine on top of it.
 *
 * @param {object} params
 * @param {string} params.comm Target engine comm ('llama-server' | 'ds4-server').
 * @param {() => Array<{pid:number, comm:string}>} params.readProcTable Reads the current host proc table.
 * @param {(pid:number, signal:string) => void} params.kill Sends a signal to a pid (may throw; ignored).
 * @param {number} [params.timeoutMs=20000] Give up waiting after this long.
 * @param {number} [params.intervalMs=250] Delay between polls.
 * @param {(ms:number)=>Promise<void>} [params.sleep] Delay function (injectable for tests).
 * @param {() => number} [params.now] Clock (injectable for tests).
 * @param {(msg:string)=>void} [params.log] Optional logger.
 * @returns {Promise<{ok:boolean, initialPids:number[], remainingPids:number[], waitedMs:number}>}
 */
export async function killEngineByComm({
  comm,
  readProcTable,
  kill,
  timeoutMs = 20_000,
  intervalMs = 250,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log,
} = {}) {
  const start = now();
  const initial = enginePids(readProcTable(), comm);
  if (initial.length === 0) {
    return { ok: true, initialPids: [], remainingPids: [], waitedMs: 0 };
  }
  if (log) log(`[engine-kill] SIGKILL ${comm} pids [${initial.join(', ')}] (host, PID namespace)`);
  signalAll(initial, kill);

  let remaining = enginePids(readProcTable(), comm);
  while (remaining.length > 0) {
    const waited = now() - start;
    if (waited >= timeoutMs) {
      if (log) log(`[engine-kill] ${comm} pids [${remaining.join(', ')}] still resident after ${Math.round(waited / 1000)}s — possible D-state/wedged GPU`);
      return { ok: false, initialPids: initial, remainingPids: remaining, waitedMs: waited };
    }
    await sleep(intervalMs);
    signalAll(remaining, kill); // re-signal survivors
    remaining = enginePids(readProcTable(), comm);
  }
  return { ok: true, initialPids: initial, remainingPids: [], waitedMs: now() - start };
}

/** SIGKILL each pid, swallowing per-pid errors (ESRCH/EPERM) so one failure never aborts the sweep. */
function signalAll(pids, kill) {
  for (const pid of pids) {
    try { kill(pid, 'SIGKILL'); } catch { /* already gone / not permitted — ignore */ }
  }
}
