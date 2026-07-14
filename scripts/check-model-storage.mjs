// Llama Manager — model storage validation for the service identity.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Before llama-managerctl persists a model directory, this command resolves the
// canonical path, reads the fixed llama-manager account's UID/groups, and
// applies the conservative POSIX access policy to every path component.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { serviceIdentityCanUseDirectory } from '../api/storage-access.js';

const selected = process.argv[2];
if (!selected || !path.isAbsolute(selected)) {
  console.error('Model storage path must be absolute.');
  process.exit(2);
}

let serviceUid;
let serviceGids;
let canonical;
try {
  serviceUid = Number(execFileSync('/usr/bin/id', ['-u', 'llama-manager'], { encoding: 'utf8' }).trim());
  serviceGids = execFileSync('/usr/bin/id', ['-G', 'llama-manager'], { encoding: 'utf8' })
    .trim().split(/\s+/).filter(Boolean).map(Number);
  canonical = fs.realpathSync(selected);
} catch (error) {
  console.error(`Cannot validate model storage as llama-manager: ${error.message}`);
  process.exit(1);
}

const parsed = path.parse(canonical);
const components = [];
let current = parsed.root;
const addComponent = (componentPath) => {
  const stat = fs.statSync(componentPath);
  components.push({
    path: componentPath,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    isDirectory: stat.isDirectory(),
  });
};

try {
  addComponent(current);
  for (const segment of canonical.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    addComponent(current);
  }
} catch (error) {
  console.error(`Cannot inspect model storage path: ${error.message}`);
  process.exit(1);
}

const decision = serviceIdentityCanUseDirectory({ serviceUid, serviceGids, components });
if (!decision.ok) {
  console.error(`Model storage is not usable by the llama-manager service identity at ${decision.path}: ${decision.reason}`);
  process.exit(1);
}

console.log(`Model storage is accessible to llama-manager: ${canonical}`);
