#!/usr/bin/env node
// Llama Manager local CLI executable.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This stable source-tree and installed-layout entrypoint delegates all parsing,
// HTTP execution, output projection, help, and error handling to the adjacent
// CLI core module, then exits with its deterministic status code.

'use strict';

const { main } = require('./core.js');

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
});
