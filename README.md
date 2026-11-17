# bun-sqlite-zstd

Personal test project (**not production ready**): [sqlite-zstd](https://github.com/phiresky/sqlite-zstd)
— transparent dictionary-based row-level zstd compression for SQLite —
packaged for Bun as prebuilt extension binaries for 7 platforms.

I needed an easy way to use sqlite-zstd from Bun on my Mac (arm64), so
this was built quickly with AI. It is a personal-need project, not a
maintained library. Upstream itself warns: *"I wouldn't trust it with my
data (yet)"*.

## Install

```sh
bun add @ndqp/bun-sqlite-zstd
```

Bun-only. Node.js `node:sqlite` blocks `loadExtension()`, so this
package cannot work there.

## Quick start

```js
import { openDatabase } from "@ndqp/bun-sqlite-zstd";

const db = openDatabase("app.db");

// Plain compress / decompress.
const compressed = db.query("select zstd_compress(?, 9) as c").get("hello ".repeat(1000)).c;
const back = db.query("select zstd_decompress(?, 1) as out").get(compressed).out;

// Transparent compression: the table stays a normal table to read/write.
db.exec(`create table events(id integer primary key, data text);`);
db.query(
  `select zstd_enable_transparent('{"table": "events", "column": "data", "compression_level": 9, "dict_chooser": "''a''"}')`,
).get();
db.query("select zstd_incremental_maintenance(null, 1)").get();
db.exec("vacuum;");
// Reads, updates and deletes go through the view exactly as before.
```

## macOS

Bun on macOS uses Apple's system SQLite, which is built **without**
extension loading. You need Homebrew SQLite:

```sh
brew install sqlite
```

Then either use `openDatabase()` (it handles this for you) or, if you
open the Database yourself, call `setupSQLite()` **before** creating
any Database:

```js
import { Database } from "bun:sqlite";
import { setupSQLite, loadExtension } from "@ndqp/bun-sqlite-zstd";

setupSQLite(); // picks /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
const db = new Database("app.db");
loadExtension(db);
```

If you use your own SQLite build, call
`Database.setCustomSQLite(path)` yourself first and set
`BUN_SQLITE_ZSTD_SKIP_SETUP=1` so `openDatabase()` does not override it.

On Linux and Windows `setupSQLite()` is a no-op.

## API

- `openDatabase(filename = ":memory:", options?)` — open a
  `bun:sqlite` Database with the extension loaded. On macOS runs
  `setupSQLite()` first and throws a clear error when no Homebrew
  SQLite is found. `options.extensionPath` overrides the binary;
  `options.sqliteOptions` passes through to `new Database(...)`.
- `loadExtension(db, options?)` — load the extension into an existing
  Database. Returns the same Database, so calls chain.
- `setupSQLite(): boolean` — macOS only, see above. Returns true when
  a Homebrew SQLite was selected.
- `getExtensionPath(): string` — the resolved extension binary path.

Environment variables:

- `BUN_SQLITE_ZSTD_PATH` — use this extension binary instead of the
  prebuilt one (e.g. a local `cargo build` before the first release).
- `BUN_SQLITE_ZSTD_SKIP_SETUP=1` — `openDatabase()` skips `setupSQLite()`.
- `BUN_SQLITE_ZSTD_SKIP_PREBUILT_CHECK=1` — skip the postinstall check.

## Platforms

Prebuilt binaries, one per platform package (installed automatically
as `optionalDependencies`):

| npm triple | Binary |
| --- | --- |
| darwin-arm64 | `libsqlite_zstd.dylib` |
| linux-x64-gnu | `libsqlite_zstd.so` |
| linux-x64-musl | `libsqlite_zstd.so` |
| linux-arm64-gnu | `libsqlite_zstd.so` |
| linux-arm64-musl | `libsqlite_zstd.so` |
| win32-x64-msvc | `sqlite_zstd.dll` |
| win32-arm64-msvc | `sqlite_zstd.dll` |

No Intel Mac build (no Intel macOS runners, not needed). No
source-build fallback: if no prebuilt fits your machine, install fails
loudly with `ERR_BUN_SQLITE_ZSTD_NO_PREBUILT` instead of silently
succeeding and breaking at first use. (Note: Bun blocks the
postinstall check by default unless the package is trusted, so under
Bun the failure surfaces at first `loadExtension()` / `openDatabase()`
instead of at install time.)

## Benchmarks

Measured on this VM (Bun 1.4.4, Linux x86_64) with `bun bench/bench.ts`.
1MB input is patterned bytes; rows are ~585B JSON.

| | |
| --- | --- |
| compress 1MB, level 3 | 896 MB/s |
| compress 1MB, level 9 | 376 MB/s |
| compress 1MB, level 19 | 8 MB/s — level 19 is slow on 1MB inputs; use 3 or 9 |
| decompress 1MB (level 9) | 715 MB/s |
| compress 585B row, level 3 / 9 | 8.8 µs / 9.9 µs per call |
| decompress 585B row | 6.5 µs per call |
| compress 585B row, dict by id / by blob (level 9) | 9.8 µs / 13.2 µs per call |
| decompress 585B row, dict by id / by blob | 7.0 µs / 11.5 µs per call |
| transparent maintenance, 2000 rows | 92.6 ms |
| transparent, 2000 JSON rows | 1,376,256 → 110,592 bytes (92% shrink) |

## What's different from upstream

Bundles phiresky/sqlite-zstd **0.3.5**, with these changes (see
[docs/FORK.md](docs/FORK.md)):

- **zstd upgraded 1.5.2 → 1.5.7** (zstd-rs 0.11.2 → 0.14.4). Level 3
  is faster, level 19 on small rows is slower (17 → 27 µs) — accepted,
  this package is used at levels 3 and 9.
- **Dictionary-as-blob no longer re-prepares the dictionary on every
  call.** Upstream measured ~273 µs/call for compress with a blob dict
  vs ~28 µs by dict id; the blob dict is now cached by content (hash +
  length + level, full bytes verified on hit, 32 entries, 10 min TTL),
  so compress is ~13 µs/call and decompress ~12 µs/call. Output is
  byte-identical to the by-id path (tested).
- **Corrupt input now errors** instead of silently decoding to an
  empty string (new zstd behaviour: `Unknown frame descriptor`).
  Empty input and a bare magic still decode to `""`.
- **WITHOUT ROWID tables work** (0.1.2): upstream maintenance chunked
  by `rowid`, which does not exist on WITHOUT ROWID tables, so
  `zstd_incremental_maintenance()` failed with `no such column: rowid`
  once a group passed the dict-training threshold. Maintenance now
  chunks by primary key instead. No change for rowid tables.
- Minor clippy cleanups (deprecated chrono calls, redundant `&` in
  format args, a debug `println!` in a test) so `cargo clippy
  -- -D warnings` passes.

Upstream behaviours kept as-is: groups under ~500 kB total stay
uncompressed by design; `zstd_train_dict` sampling is random, so
trained dictionaries differ between runs.

## Credits

- [sqlite-zstd](https://github.com/phiresky/sqlite-zstd) by
  [phiresky](https://github.com/phiresky) — the extension itself
  (LGPL-2.0-or-later; see `LICENSE-UPSTREAM`). This package is a
  fork/packaging of that code, not a rewrite.
- [zstd](https://github.com/facebook/zstd) by Meta — the compression
  library (BSD).
- [rusqlite](https://github.com/rusqlite/rusqlite) — the Rust SQLite
  bindings (MIT).

## License

The wrapper code in this repo (loader, packaging, tests) is MIT (see
`LICENSE`). The bundled extension binary is built from upstream
sqlite-zstd code under LGPL-2.0-or-later (see `LICENSE-UPSTREAM` and
`Cargo.toml`); it is shipped as a separate dynamically-loaded file,
never statically linked into anything. Note: upstream's `LICENSE`
file text is LGPLv3 while its `Cargo.toml` declares LGPL-2.0-or-later —
that discrepancy is upstream's, copied verbatim.

## Development

```sh
npm run build        # cargo build --release --features build_extension
bun test test/       # JS tests (21)
cargo test           # Rust tests (15)
npm run typecheck
npm run bench
```

Release: push a `v*` tag — the release workflow builds all 7
platforms and publishes the main package + platform packages to npm.
Requires the `NPM_TOKEN` repository secret (npm granular token with
publish access and "Bypass 2FA").
