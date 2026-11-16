'use strict';

// bun-sqlite-zstd — sqlite-zstd (transparent dictionary-based row-level
// zstd compression for SQLite) packaged for Bun.
//
// Bun-only: `bun:sqlite` is the only SQLite API that can load extensions
// here. Node.js `node:sqlite` blocks `loadExtension()` entirely, so this
// package does not support Node.
//
// The extension binary is resolved by lib/loader.js (local dev build,
// $BUN_SQLITE_ZSTD_PATH, or the matching @ndqp/bun-sqlite-zstd-<triple>
// platform package) and fails loudly with
// ERR_BUN_SQLITE_ZSTD_NO_PREBUILT when no prebuilt binary fits this
// machine. This package never builds from source on install (see README).
//
// macOS: Bun uses Apple's system SQLite there, which is built without
// extension loading. Call setupSQLite() (or use openDatabase(), which
// calls it) before creating any Database, with Homebrew SQLite installed
// (`brew install sqlite`). On Linux and Windows this is a no-op.

const fs = require('node:fs');
const path = require('node:path');
const loader = require('./lib/loader.js');

const PACKAGE_NAME = '@ndqp/bun-sqlite-zstd';

/** Homebrew SQLite locations, Apple Silicon first, then Intel. */
const HOMEBREW_SQLITE_CANDIDATES = [
  process.env.HOMEBREW_PREFIX
    ? path.join(process.env.HOMEBREW_PREFIX, 'opt', 'sqlite', 'lib', 'libsqlite3.dylib')
    : null,
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
].filter(Boolean);

function requireBunSQLite() {
  try {
    return require('bun:sqlite');
  } catch (err) {
    const error = new Error(
      `${PACKAGE_NAME}: this package requires Bun (bun:sqlite). ` +
        `Node.js blocks SQLite extension loading, so it cannot load sqlite-zstd.`,
    );
    error.cause = err;
    throw error;
  }
}

/**
 * On macOS, point Bun at a Homebrew SQLite that supports extensions.
 * Must be called before any Database is created. Returns true when a
 * custom SQLite was selected, false on other platforms or when no
 * Homebrew SQLite was found.
 *
 * If you use your own SQLite build instead, call
 * `Database.setCustomSQLite(path)` yourself before opening any Database
 * and set BUN_SQLITE_ZSTD_SKIP_SETUP=1 so openDatabase() does not
 * override it.
 */
function setupSQLite() {
  if (process.platform !== 'darwin') return false;
  if (process.env.BUN_SQLITE_ZSTD_SKIP_SETUP === '1') return false;
  const { Database } = requireBunSQLite();
  for (const candidate of HOMEBREW_SQLITE_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      Database.setCustomSQLite(candidate);
      return true;
    }
  }
  return false;
}

/**
 * Resolve the extension binary path for this machine.
 * @throws {Error} with code ERR_BUN_SQLITE_ZSTD_NO_PREBUILT when none fits.
 */
function getExtensionPath() {
  return loader.resolveExtensionPath();
}

/**
 * Load the sqlite-zstd extension into an existing bun:sqlite Database.
 * Returns the same Database, so calls chain.
 *
 * @param {object} db - a `bun:sqlite` Database (must have loadExtension)
 * @param {object} [options]
 * @param {string} [options.extensionPath] - use this binary instead of the resolved prebuilt
 * @throws {Error} with code ERR_BUN_SQLITE_ZSTD_NO_PREBUILT when no binary fits,
 *   or a wrapped load error (on macOS, usually Apple's SQLite: call
 *   setupSQLite() first — see above).
 */
function loadExtension(db, options = {}) {
  if (!db || typeof db.loadExtension !== 'function') {
    throw new Error(
      `${PACKAGE_NAME}: loadExtension expects a bun:sqlite Database (with a loadExtension method). ` +
        `Use openDatabase() to open one, or pass a Database from 'bun:sqlite'.`,
    );
  }
  const extPath = options.extensionPath || loader.resolveExtensionPath();
  try {
    db.loadExtension(extPath);
  } catch (err) {
    const hint =
      process.platform === 'darwin'
        ? ` On macOS, Bun uses Apple's SQLite, which cannot load extensions — ` +
          `call setupSQLite() (or use openDatabase()) before creating the Database, ` +
          `and install Homebrew SQLite with \`brew install sqlite\`.`
        : '';
    const error = new Error(
      `${PACKAGE_NAME}: failed to load the sqlite-zstd extension from ${extPath}: ${err.message}.${hint}`,
    );
    error.cause = err;
    throw error;
  }
  return db;
}

/**
 * Open a bun:sqlite Database with the sqlite-zstd extension already loaded.
 * On macOS this runs setupSQLite() first (unless
 * BUN_SQLITE_ZSTD_SKIP_SETUP=1) and throws a clear error when no Homebrew
 * SQLite is installed.
 *
 * @param {string} [filename=':memory:']
 * @param {object} [options]
 * @param {string} [options.extensionPath] - use this binary instead of the resolved prebuilt
 * @param {object} [options.sqliteOptions] - passed through to `new Database(filename, sqliteOptions)`
 */
function openDatabase(filename = ':memory:', options = {}) {
  const { Database } = requireBunSQLite();
  if (process.platform === 'darwin' && process.env.BUN_SQLITE_ZSTD_SKIP_SETUP !== '1') {
    if (!setupSQLite()) {
      throw new Error(
        `${PACKAGE_NAME}: no Homebrew SQLite found on macOS. ` +
          `Bun uses Apple's SQLite there, which cannot load extensions. ` +
          `Install it with \`brew install sqlite\`, or call ` +
          `Database.setCustomSQLite(path)` +
          ` yourself before opening the Database and set BUN_SQLITE_ZSTD_SKIP_SETUP=1.`,
      );
    }
  }
  const db = new Database(filename, options.sqliteOptions);
  return loadExtension(db, options);
}

module.exports = {
  setupSQLite,
  getExtensionPath,
  loadExtension,
  openDatabase,
  SUPPORTED_TARGETS: loader.SUPPORTED_TARGETS,
};
