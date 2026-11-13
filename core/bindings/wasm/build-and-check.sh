#!/bin/sh
# core:wasm. Build the WebAssembly module, with the cryptography compiled in,
# shrink it with wasm-opt, report its size, and run the golden vectors through
# it from Node.
#
# Output goes to /opt/core/wasm in the core-cache volume, not the checkout:
# the module, and beside it the wrapper fortymm-core.mjs and its types
# fortymm-core.d.mts, so that one directory is the whole browser build. The
# web client reads it from there (compose.dev.yaml, web-client/vite.config.ts).
set -eu

out=/opt/core/wasm
mkdir -p "$out"
cd /app

# Intermediate files go to a directory of this run's own, and each finished
# file is renamed into $out: the web client may be reading the previous build,
# and another core:wasm may be running at the same time (validate runs
# web-client's and core's checks side by side), so no reader ever sees half a
# file.
work=$(mktemp -d "$out/.build.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Size-tuned release build: optimise for size, abort on panic (no unwinding
# tables), strip symbols.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_PROFILE_RELEASE_STRIP=true

cargo build --locked --release --package fortymm-core-wasm \
  --target wasm32-unknown-unknown --target-dir /opt/core/target-wasm
cp /opt/core/target-wasm/wasm32-unknown-unknown/release/fortymm_core_wasm.wasm \
  "$work/fortymm-core.raw.wasm"
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$work/fortymm-core.raw.wasm" -o "$work/fortymm-core.wasm"
gzip -9 -k -f "$work/fortymm-core.wasm"

size() { wc -c < "$1" | tr -d ' '; }
echo
echo "WebAssembly size in bytes   cargo build   after wasm-opt -Oz   gzip -9"
printf '%-27s %11s %20s %9s\n' fortymm-core \
  "$(size "$work/fortymm-core.raw.wasm")" "$(size "$work/fortymm-core.wasm")" \
  "$(size "$work/fortymm-core.wasm.gz")"
echo

node bindings/wasm/check-vectors.mjs vectors/vectors.json "$work/fortymm-core.wasm"

# Published only once the vectors pass: the module, and the wrapper and its
# types beside it.
cp bindings/wasm/fortymm-core.mjs bindings/wasm/fortymm-core.d.mts "$work/"
for file in fortymm-core.raw.wasm fortymm-core.wasm fortymm-core.wasm.gz \
  fortymm-core.mjs fortymm-core.d.mts; do
  mv "$work/$file" "$out/$file"
done
