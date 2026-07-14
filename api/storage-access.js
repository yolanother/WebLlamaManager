// Llama Manager — service-identity model storage access policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This pure module evaluates a canonical directory path against the fixed
// service UID and group set. It conservatively requires executable traversal on
// every ancestor and read/write/execute permission on the model directory.

/** Resolve the applicable owner/group/other permission bits for one path. */
function identityBits(component, serviceUid, serviceGids) {
  const mode = Number(component.mode) & 0o777;
  if (Number(component.uid) === Number(serviceUid)) return (mode >> 6) & 0o7;
  if (serviceGids.map(Number).includes(Number(component.gid))) return (mode >> 3) & 0o7;
  return mode & 0o7;
}

/**
 * Determine whether a service identity can use a canonical model directory.
 *
 * @param {{serviceUid:number,serviceGids:number[],components:Array<{
 *   path:string,uid:number,gid:number,mode:number,isDirectory:boolean}>}} input
 *   Identity plus canonical path components ordered from filesystem root to target.
 * @returns {{ok:true}|{ok:false,path:string,reason:string}} Access decision.
 */
export function serviceIdentityCanUseDirectory({ serviceUid, serviceGids = [], components = [] }) {
  if (!components.length) return { ok: false, path: '', reason: 'No directory path was provided.' };
  for (let i = 0; i < components.length; i += 1) {
    const component = components[i];
    if (!component.isDirectory) {
      return { ok: false, path: component.path, reason: 'Every path component must be a directory.' };
    }
    const bits = identityBits(component, serviceUid, serviceGids);
    const target = i === components.length - 1;
    if (!target && (bits & 0o1) !== 0o1) {
      return { ok: false, path: component.path, reason: 'The service identity cannot traverse this ancestor directory.' };
    }
    if (target && (bits & 0o7) !== 0o7) {
      return { ok: false, path: component.path, reason: 'The service identity needs read, write, and traverse access to the model directory.' };
    }
  }
  return { ok: true };
}
