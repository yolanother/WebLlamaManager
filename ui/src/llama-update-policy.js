// Llama Manager — dashboard llama.cpp update presentation policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This pure adapter converts API distribution status into dashboard controls,
// ensuring package installations expose APT guidance instead of source mutation.

/**
 * Resolve the dashboard's llama.cpp update presentation.
 *
 * @param {Record<string, unknown>|null|undefined} status API update status.
 * @returns {{packageManaged:boolean,canSourceUpdate:boolean,guidance:string,command:string}}
 *   Presentation policy for the update section.
 */
export function resolveLlamaUpdateView(status) {
  const packageManaged = status?.managedBy === 'apt' || status?.status === 'package-managed';
  return {
    packageManaged,
    canSourceUpdate: !packageManaged && status?.selfUpdateEnabled !== false,
    guidance: typeof status?.guidance === 'string' ? status.guidance : '',
    command: typeof status?.command === 'string' ? status.command : '',
  };
}
