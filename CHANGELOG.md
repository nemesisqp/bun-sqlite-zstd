# Changelog

## 0.1.0 — 2026-11-17

First release.

- Vendored phiresky/sqlite-zstd 0.3.5 as a Rust `cdylib`, packaged for
  Bun with prebuilt extension binaries for 7 platforms
  (darwin-arm64, win32-x64/arm64-msvc, linux-x64/arm64 gnu+musl).
- JS loader (`index.js` / `lib/loader.js`): resolves the right binary
  from a local build, `$BUN_SQLITE_ZSTD_PATH`, or the matching
  `@ndqp/bun-sqlite-zstd-<triple>` platform package; fails loudly with
  `ERR_BUN_SQLITE_ZSTD_NO_PREBUILT` when none fits; no source-build
  fallback. `openDatabase()` / `loadExtension()` / `setupSQLite()` /
  `getExtensionPath()` API, plus a postinstall prebuilt check.
- macOS support: `setupSQLite()` points Bun at Homebrew SQLite before
  any Database is created (Apple's system SQLite cannot load
  extensions).
- zstd upgraded 1.5.2 → 1.5.7 (zstd-rs 0.11.2 → 0.14.4).
- Dictionary-as-blob is now cached by content (was re-prepared every
  call: ~273 µs → ~13 µs per compress at level 9), byte-identical to
  the by-id path.
- Corrupt input now errors (`Unknown frame descriptor`) instead of
  silently decoding to `""` (new zstd behaviour).
- 15 Rust tests (incl. a new blob-dict cache test) + 21 JS tests,
  all passing on Linux x86_64 (Bun 1.4.4).
