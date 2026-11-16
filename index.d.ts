/**
 * @ndqp/bun-sqlite-zstd — sqlite-zstd packaged for Bun.
 *
 * Bun-only: `bun:sqlite` is the only SQLite API that can load extensions
 * here (Node.js `node:sqlite` blocks `loadExtension()`).
 *
 * These types are intentionally dependency-free: `openDatabase()` returns
 * the minimal Database surface this package needs. For the full
 * `bun:sqlite` Database type, open a Database from 'bun:sqlite' yourself
 * and pass it to `loadExtension(db)`.
 */

/** Minimal surface of a `bun:sqlite` Database used by this package. */
export interface SQLiteDatabase {
  loadExtension(path: string): void;
}

export interface LoadOptions {
  /** Use this extension binary instead of the resolved prebuilt. */
  extensionPath?: string;
}

export interface OpenOptions extends LoadOptions {
  /** Passed through to `new Database(filename, sqliteOptions)`. */
  sqliteOptions?: Record<string, unknown>;
}

/**
 * On macOS, point Bun at a Homebrew SQLite that supports extensions.
 * Must be called before any Database is created. Returns true when a
 * custom SQLite was selected, false on other platforms, when
 * BUN_SQLITE_ZSTD_SKIP_SETUP=1, or when no Homebrew SQLite was found.
 */
export function setupSQLite(): boolean;

/**
 * Resolve the extension binary path for this machine.
 * @throws An Error with code 'ERR_BUN_SQLITE_ZSTD_NO_PREBUILT' when no
 * prebuilt binary fits this machine.
 */
export function getExtensionPath(): string;

/**
 * Load the sqlite-zstd extension into an existing `bun:sqlite` Database.
 * Returns the same Database, so calls chain.
 */
export function loadExtension<T extends SQLiteDatabase>(
  db: T,
  options?: LoadOptions,
): T;

/**
 * Open a `bun:sqlite` Database with the sqlite-zstd extension already
 * loaded. On macOS this runs setupSQLite() first (unless
 * BUN_SQLITE_ZSTD_SKIP_SETUP=1) and throws a clear error when no Homebrew
 * SQLite is installed.
 */
export function openDatabase(
  filename?: string,
  options?: OpenOptions,
): SQLiteDatabase;

/** All triples CI builds (see .github/workflows/release.yml). */
export const SUPPORTED_TARGETS: string[];
