#!/usr/bin/env node
'use strict';

/**
 * postinstall guard: fail the install when no prebuilt extension binary
 * fits this machine — instead of silently succeeding and failing at
 * first use, and instead of falling back to a source build (there is none).
 *
 * Runs as the package's `postinstall` script. It only checks that the
 * binary file exists (via lib/loader.js); it never invokes cargo /
 * node-gyp / any compiler, and it does not load the extension (that
 * needs Bun + a Database — the JS tests do that).
 *
 * Skipped (warning only) in a source checkout — where Cargo.toml and
 * .git are present — so developers can install deps and then `npm run
 * build` the extension themselves. Published packages do not ship
 * Cargo.toml or .git, so the check is hard there.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const isSourceCheckout = fs.existsSync(path.join(root, 'Cargo.toml')) && fs.existsSync(path.join(root, '.git'));
const skipEnv = process.env.BUN_SQLITE_ZSTD_SKIP_PREBUILT_CHECK === '1';

if (skipEnv) {
  console.log('@ndqp/bun-sqlite-zstd: prebuilt check skipped (BUN_SQLITE_ZSTD_SKIP_PREBUILT_CHECK=1)');
  process.exit(0);
}

try {
  const extPath = require('../lib/loader.js').resolveExtensionPath();
  console.log(`@ndqp/bun-sqlite-zstd: prebuilt extension OK (${extPath})`);
} catch (err) {
  console.error(`\n${err.message}\n`);
  if (isSourceCheckout) {
    console.error(
      '@ndqp/bun-sqlite-zstd: source checkout detected — continuing anyway. ' +
        'Build the extension locally with `npm run build`.\n',
    );
    process.exit(0);
  }
  console.error(
    '@ndqp/bun-sqlite-zstd: install failed — no prebuilt extension for this platform and ' +
      'this package does not build from source on install.\n',
  );
  process.exit(1);
}
