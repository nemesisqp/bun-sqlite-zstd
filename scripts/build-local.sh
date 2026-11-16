#!/usr/bin/env bash
# Dev-local build of the sqlite-zstd extension for THIS machine only.
#
# The output lands in target/<triple>/release/ (or target/release/ for a
# host build), which lib/loader.js already looks at, so `bun test` works
# right after this without any install step.
#
# DO NOT use this for published prebuilts: CI builds each target with
# portable flags (see .github/workflows/release.yml). Never add
# `-C target-cpu=native` to a shipped prebuilt — it can SIGILL on
# another CPU. zstd already runtime-dispatches SIMD.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --features build_extension
echo "Built: target/release/libsqlite_zstd.$(uname | grep -qi darwin && echo dylib || echo so)"
