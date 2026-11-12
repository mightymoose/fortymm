#!/bin/sh
# core:wasm. Build the WebAssembly module, with the cryptography compiled in,
# shrink it with wasm-opt, report its size, and run the golden vectors through
# it from Node.
#
# Output goes to /opt/core/wasm in the core-cache volume, not the checkout.
set -eu

out=/opt/core/wasm
mkdir -p "$out"
cd /app

# Size-tuned release build: optimise for size, abort on panic (no unwinding
# tables), strip symbols.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_PROFILE_RELEASE_STRIP=true

cargo build --locked --release --package fortymm-core-wasm \
  --target wasm32-unknown-unknown --target-dir /opt/core/target-wasm
cp /opt/core/target-wasm/wasm32-unknown-unknown/release/fortymm_core_wasm.wasm \
  "$out/fortymm-core.raw.wasm"
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$out/fortymm-core.raw.wasm" -o "$out/fortymm-core.wasm"
gzip -9 -k -f "$out/fortymm-core.wasm"

size() { wc -c < "$1" | tr -d ' '; }
echo
echo "WebAssembly size in bytes   cargo build   after wasm-opt -Oz   gzip -9"
printf '%-27s %11s %20s %9s\n' fortymm-core \
  "$(size "$out/fortymm-core.raw.wasm")" "$(size "$out/fortymm-core.wasm")" \
  "$(size "$out/fortymm-core.wasm.gz")"
echo

node bindings/wasm/check-vectors.mjs vectors/vectors.json "$out/fortymm-core.wasm"
