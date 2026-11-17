# Fork notes

This repo vendors [phiresky/sqlite-zstd](https://github.com/phiresky/sqlite-zstd)
v0.3.5 (commit history not preserved — the upstream source was copied
in) and changes the following. Upstream's own README is kept at
[UPSTREAM-README.md](UPSTREAM-README.md).

## Why a fork

Upstream ships only 5 prebuilt binaries (Linux x64 gnu, Linux ARM
32-bit, macOS Intel only, Windows x64 gnu + msvc) and no npm package.
This fork exists to get a prebuilt extension for every platform in the
`@ndqp/bun-rusty-opus` / `@ndqp/bun-rusty-mp3` set — above all
darwin-arm64 (Mac) — installable with `bun add`, plus a JS loader that
knows how to find the right binary and how to point Bun at Homebrew
SQLite on macOS.

An optimization audit (Nov 2026, full notes in the investigation that
preceded this repo) concluded there is **no noteworthy general
optimization** in sqlite-zstd: the hot code is already Rust calling the
zstd C library at near-C speed. This fork therefore changes nothing
about the compression core except the items below (the WITHOUT ROWID
fix in 0.1.2 is a bug fix in the maintenance SQL, not an optimization).

## Changes vs upstream 0.3.5

### zstd 1.5.2 → 1.5.7 (zstd-rs 0.11.2 → 0.14.4)

`Cargo.toml`: `zstd = {version = "0.14.4", features = ["experimental"]}`.
One API fix required: `set_pledged_src_size` now takes `Option<u64>`
(`src/basic.rs`).

A/B on this VM: level 3 faster, level 19 slower on small rows
(17 → 27 µs), decompress slightly faster. Level 19 regression is
accepted — this package is used at levels 3 and 9.

Side effect: with zstd 1.5.7, corrupt input now **errors**
(`Unknown frame descriptor`) instead of silently decoding to an empty
string (the old behaviour with 1.5.2). Empty input and a bare magic
still decode to `""`. Pinned by a test in `test/basic.test.ts`.

### Dictionary-as-blob cache (`src/dict_management.rs`)

Upstream re-prepared a blob-passed dictionary on every call
(`Compressor::with_dictionary` / `DecoderDictionary::copy`), measured
at ~273 µs/call for compress vs ~28 µs by dict id. New functions
`encoder_dict_from_blob` / `decoder_dict_from_blob` cache prepared
dictionaries by content: key is (hash, length[, level]), the full
bytes are verified on a hit (so a hash collision is harmless — worst
case it rebuilds), 32 entries, 10-minute TTL. A blob dictionary is
content-addressed, so entries can never go stale.

Measured after the fix (585B row, level 9, Bun): compress by blob
13.2 µs/call vs 9.8 µs by id; decompress by blob 11.5 µs vs 7.0 µs by
id. Output is byte-identical to the by-id path (Rust test
`blob_dict_matches_id_dict` in `src/add_functions.rs` + JS tests in
`test/basic.test.ts`).

### WITHOUT ROWID maintenance fix (`src/transparent.rs`, 0.1.2)

Upstream's incremental maintenance compressed each chunk with
`... where rowid in (select rowid from _tbl_zstd where ...)`. WITHOUT
ROWID tables have no `rowid` pseudo-column, so maintenance failed with
`no such column: rowid` — but only once a group passed the ~500 kB
dict-training threshold, so small tables looked fine. Enable, the view,
the triggers, dict training and VACUUM all already worked on WITHOUT
ROWID; only this one statement assumed a rowid.

The fix chunks by primary key instead: `where (pk1, pk2, ...) in
(select pk1, pk2, ... where ... limit :chunksize)` (row-value `IN`,
SQLite ≥ 3.15; the extension already requires ≥ 3.49.1). PK columns are
re-derived at maintenance time with
`select name from pragma_table_info(?) where pk > 0 order by pk` on the
shadow table — the stored config carries no PK info, and re-deriving
keeps already-enabled databases working. A PK is guaranteed (enable
bails without one) and the compressed column can never be part of it.
On rowid tables this is a PK-index seek per chunk row instead of a
rowid seek (measured: no change in shrink or maintenance time at 20k
rows); on WITHOUT ROWID tables the table *is* the PK B-tree. Covered by
Rust tests `without_rowid_transparent` (TEXT PK) and
`without_rowid_composite_pk`, plus a JS test in
`test/transparent.test.ts`.

### Clippy cleanups (no behaviour change)

So `cargo clippy --all-targets -- -D warnings` passes:

- `src/add_functions.rs`: deprecated chrono `ymd`/`and_hms` →
  `with_ymd_and_hms(...).single().unwrap()`; removed a debug
  `println!` from a test.
- `src/transparent.rs`: removed redundant `&` in `format!`/`debug!`/
  `bail!` arguments.
- Removed the unused `owning_ref` dependency from `Cargo.toml`.
  (`lazy_static` stays: it is used by the tests.)

### Build profile (`Cargo.toml`)

`[profile.release]` is now `lto = "fat"`, `codegen-units = 1`,
`strip = true`. Never `-C target-cpu=native` in shipped prebuilts.

## Not changed

- The compression core, dict training, and the SQLite function surface
  are upstream code, unchanged. Transparent-compression logic is
  unchanged except the maintenance chunk UPDATE (WITHOUT ROWID fix
  above) — enable, view, triggers and dict training are untouched.
- Upstream behaviours kept as-is: groups under ~500 kB total stay
  uncompressed by design; `zstd_train_dict` sampling is random.
- License: the Rust crate stays `LGPL-2.0-or-later` per upstream's
  `Cargo.toml`; the upstream `LICENSE` file (LGPLv3 text) is copied
  verbatim as `LICENSE-UPSTREAM`. The discrepancy between the two is
  upstream's, not introduced here.
