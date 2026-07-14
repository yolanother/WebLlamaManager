// Llama Manager — packaged Node runtime startup validation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Executed by the canonical system service before the API starts, this script
// verifies that the bundled offline Node runtime satisfies the application's
// explicit minimum instead of relying on Ubuntu Noble's system Node package.

import { MINIMUM_NODE_VERSION, nodeVersionIsSupported } from '../api/node-runtime.js';

if (!nodeVersionIsSupported(process.version)) {
  console.error(
    `Llama Manager requires bundled Node >= ${MINIMUM_NODE_VERSION}; found ${process.version}. ` +
    'Reinstall or upgrade the signed llama-manager package.',
  );
  process.exit(1);
}

console.log(`Llama Manager bundled Node ${process.version} satisfies >= ${MINIMUM_NODE_VERSION}.`);
