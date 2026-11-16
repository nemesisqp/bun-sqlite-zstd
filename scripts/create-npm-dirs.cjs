#!/usr/bin/env node
'use strict';

/**
 * Generate the 7 platform packages under npm/<triple>/, each with its
 * own package.json and its prebuilt extension binary.
 *
 * Usage:
 *   node scripts/create-npm-dirs.mjs [--artifacts <dir>]
 *
 * --artifacts <dir> is the CI layout: one `ext-<rust-target>/` subdir
 * per build job (from actions/download-artifact, no merging), each
 * holding its binary. Without it, binaries are taken from the local
 * layout target/<rust-target>/release/ (useful for a dry run of one
 * target; missing binaries are warned about, not fatal).
 *
 * The platform package.json files carry os/cpu/libc fields, which is
 * what makes npm/bun install only the matching platform package from
 * the main package's optionalDependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const loader = require('../lib/loader.js');

const root = path.join(__dirname, '..');
const mainPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = mainPkg.version;

const args = process.argv.slice(2);
let artifactsDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--artifacts' && args[i + 1]) artifactsDir = args[++i];
}

/** npm triple -> os/cpu/libc for the platform package.json. */
const PLATFORM_META = {
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'linux-arm64-gnu': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  'win32-x64-msvc': { os: ['win32'], cpu: ['x64'] },
  'win32-arm64-msvc': { os: ['win32'], cpu: ['arm64'] },
};

let copied = 0;
for (const triple of loader.SUPPORTED_TARGETS) {
  const file = loader.EXTENSION_FILE[triple];
  const rustTarget = loader.RUST_TARGET[triple];
  const dir = path.join(root, 'npm', triple);
  fs.mkdirSync(dir, { recursive: true });

  const pkg = {
    name: `${loader.PACKAGE_NAME}-${triple}`,
    version: VERSION,
    description: `Prebuilt sqlite-zstd extension binary for ${triple} (used by ${loader.PACKAGE_NAME}).`,
    license: 'LGPL-2.0-or-later',
    homepage: mainPkg.homepage,
    repository: mainPkg.repository,
    ...PLATFORM_META[triple],
    files: [file],
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // Local layout: a target/<rust-target>/release build is unambiguous,
  // but a host build in target/release/ only belongs to the triple of
  // THIS machine — never copy it into another platform's package.
  const hostTriple = loader.candidateTriples()[0];
  const candidates = artifactsDir
    ? [path.join(artifactsDir, `ext-${rustTarget}`, file)]
    : [
        path.join(root, 'target', rustTarget, 'release', file),
        ...(triple === hostTriple ? [path.join(root, 'target', 'release', file)] : []),
      ];
  const src = candidates.find((c) => fs.existsSync(c));
  if (src) {
    fs.copyFileSync(src, path.join(dir, file));
    console.log(`${triple} <- ${src}`);
    copied++;
  } else {
    console.warn(`warning: no binary found for ${triple} (looked in ${candidates.join(', ')})`);
  }
}

console.log(`create-npm-dirs: ${copied}/${loader.SUPPORTED_TARGETS.length} platform packages got a binary`);
