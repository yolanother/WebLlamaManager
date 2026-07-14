// Llama Manager — software distribution and update-mechanism policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This pure module distinguishes immutable signed-package installations from
// mutable source checkouts. It prevents package services from running git-based
// DS4 builders while preserving the developer updater for source deployments.

/** Signed-APT upgrade command displayed by package-managed API surfaces. */
export const PACKAGED_DS4_UPGRADE_COMMAND =
  'sudo apt update && sudo apt install --only-upgrade llama-manager-ds4';

/**
 * Resolve the software-update policy for the current distribution mode.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Process environment.
 * @returns {{packaged:boolean, ds4SelfUpdateAllowed:boolean, updateManager:'apt'|'source',
 *   guidance:string, command:(string|null)}} Observable update policy.
 */
export function resolveDistributionPolicy(env = {}) {
  const packaged = env.LLAMA_MANAGER_PACKAGED === '1' || env.LLAMA_MANAGER_PACKAGED === 'true';
  if (packaged) {
    return {
      packaged: true,
      ds4SelfUpdateAllowed: false,
      updateManager: 'apt',
      guidance: 'DS4 is package-managed. Upgrade it through the signed APT repository.',
      command: PACKAGED_DS4_UPGRADE_COMMAND,
    };
  }
  return {
    packaged: false,
    ds4SelfUpdateAllowed: true,
    updateManager: 'source',
    guidance: 'DS4 source self-update is available for this mutable checkout.',
    command: null,
  };
}

/**
 * Return the package-managed DS4 update status, or null for source mode.
 *
 * @param {ReturnType<typeof resolveDistributionPolicy>} policy Distribution policy.
 * @returns {{managedBy:'apt',selfUpdateEnabled:false,guidance:string,command:string}|null}
 *   Status body for package API responses.
 */
export function packagedDs4UpdateStatus(policy) {
  if (!policy?.packaged) return null;
  return {
    managedBy: 'apt',
    selfUpdateEnabled: false,
    guidance: policy.guidance,
    command: policy.command,
  };
}

/**
 * Return a package-managed rejection for a DS4 self-update mutation.
 *
 * @param {ReturnType<typeof resolveDistributionPolicy>} policy Distribution policy.
 * @param {'check'|'apply'|string} action Requested git-updater action.
 * @returns {{status:409,body:{code:'PACKAGE_MANAGED',error:string,guidance:string,command:string}}|null}
 *   HTTP response descriptor, or null when the source updater may proceed.
 */
export function packagedDs4UpdateRejection(policy, action) {
  if (!policy?.packaged) return null;
  return {
    status: 409,
    body: {
      code: 'PACKAGE_MANAGED',
      error: `Cannot ${action} DS4 with the source self-updater in a package-managed installation.`,
      guidance: policy.guidance,
      command: policy.command,
    },
  };
}
