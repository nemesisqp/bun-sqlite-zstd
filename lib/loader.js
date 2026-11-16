'use strict';

/**
 * Resolve the prebuilt sqlite-zstd extension binary for this machine —
 * and fail loudly if there is none.
 *
 * The extension is a plain SQLite loadable extension (a .so / .dylib /
 * .dll), not a Node-API binding, so there is no generated loader to
 * delegate to. This file finds the right binary in this order:
 *
 *   1. $BUN_SQLITE_ZSTD_PATH, when set (explicit override, e.g. a local
 *      `cargo build` on macOS before the first npm release).
 *   2. A local dev build: target/<rust-target>/release/<file> or
 *      target/release/<file> in a source checkout.
 *   3. The platform package `@ndqp/bun-sqlite-zstd-<triple>` installed
 *      as an optionalDependency (one binary per platform, same 7
 *      targets as @ndqp/bun-rusty-opus / @ndqp/bun-rusty-mp3).
 *
 * There is intentionally NO build fallback here: no cargo, no node-gyp,
 * no postinstall compile. If no prebuilt fits this machine, loading
 * throws (and the `postinstall` check in `scripts/check-prebuilt.js`
 * makes `npm install` / `bun install` fail at install time instead of
 * at first use).
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = '@ndqp/bun-sqlite-zstd';

/** All triples CI builds (see .github/workflows/release.yml). */
const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-x64-musl',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'win32-x64-msvc',
  'win32-arm64-msvc',
];

/** Extension file name shipped in each platform package. */
const EXTENSION_FILE = {
  'darwin-arm64': 'libsqlite_zstd.dylib',
  'linux-x64-gnu': 'libsqlite_zstd.so',
  'linux-x64-musl': 'libsqlite_zstd.so',
  'linux-arm64-gnu': 'libsqlite_zstd.so',
  'linux-arm64-musl': 'libsqlite_zstd.so',
  'win32-x64-msvc': 'sqlite_zstd.dll',
  'win32-arm64-msvc': 'sqlite_zstd.dll',
};

/** npm triple -> Rust target triple (for local dev builds in target/). */
const RUST_TARGET = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64-gnu': 'x86_64-unknown-linux-gnu',
  'linux-x64-musl': 'x86_64-unknown-linux-musl',
  'linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
  'linux-arm64-musl': 'aarch64-unknown-linux-musl',
  'win32-x64-msvc': 'x86_64-pc-windows-msvc',
  'win32-arm64-msvc': 'aarch64-pc-windows-msvc',
};

function isMusl() {
  try {
    if (fs.existsSync('/etc/alpine-release')) return true;
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /musl/i.test(out);
  } catch {
    return false;
  }
}

function candidateTriples() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux') {
    const libc = isMusl() ? 'musl' : 'gnu';
    const other = libc === 'musl' ? 'gnu' : 'musl';
    return [`linux-${arch}-${libc}`, `linux-${arch}-${other}`];
  }
  if (platform === 'darwin') return [`darwin-${arch}`];
  if (platform === 'win32') return [`win32-${arch}-msvc`];
  return [];
}

function detectedTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux') return `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}`;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

function noPrebuiltError() {
  const error = new Error(
    `${PACKAGE_NAME}: no prebuilt sqlite-zstd extension for this machine (${detectedTriple()}).\n` +
      `Supported targets: ${SUPPORTED_TARGETS.join(', ')}.\n` +
      `This package ships prebuilt binaries only and does not build from source on install. ` +
      `If your platform is not listed, please open an issue at ` +
      `https://github.com/nemesisqp/bun-sqlite-zstd/issues — do not try to build it by hand on this machine.\n` +
      `To use a binary you built yourself, set BUN_SQLITE_ZSTD_PATH to its path.`,
  );
  error.code = 'ERR_BUN_SQLITE_ZSTD_NO_PREBUILT';
  return error;
}

/**
 * Resolve the extension binary path for this machine.
 * @throws {Error} with code ERR_BUN_SQLITE_ZSTD_NO_PREBUILT when none fits.
 */
function resolveExtensionPath() {
  const envPath = process.env.BUN_SQLITE_ZSTD_PATH;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(
        `${PACKAGE_NAME}: BUN_SQLITE_ZSTD_PATH points at a missing file: ${envPath}`,
      );
    }
    return envPath;
  }

  const triples = candidateTriples();
  const root = path.join(__dirname, '..');

  // Local dev build (source checkout).
  for (const triple of triples) {
    const file = EXTENSION_FILE[triple];
    if (!file) continue;
    const dirs = [
      path.join(root, 'target', RUST_TARGET[triple], 'release'),
      path.join(root, 'target', 'release'),
    ];
    for (const dir of dirs) {
      const candidate = path.join(dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Platform package installed as an optionalDependency.
  for (const triple of triples) {
    const file = EXTENSION_FILE[triple];
    if (!file) continue;
    try {
      const pkgDir = path.dirname(
        require.resolve(`${PACKAGE_NAME}-${triple}/package.json`),
      );
      const candidate = path.join(pkgDir, file);
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Not installed — try the next candidate triple.
    }
  }

  throw noPrebuiltError();
}

module.exports = {
  resolveExtensionPath,
  candidateTriples,
  isMusl,
  SUPPORTED_TARGETS,
  EXTENSION_FILE,
  RUST_TARGET,
  PACKAGE_NAME,
};
