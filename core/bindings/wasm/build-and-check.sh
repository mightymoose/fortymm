#!/bin/sh
# core:wasm. Build the WebAssembly module twice, with and without the
# cryptography compiled in, shrink each with wasm-opt, report the sizes, and
# run the golden vectors through both from Node.
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

build() {
  name=$1
  shift
  cargo build --locked --release --package fortymm-core-wasm \
    --target wasm32-unknown-unknown --target-dir "/opt/core/target-wasm-$name" "$@"
  cp "/opt/core/target-wasm-$name/wasm32-unknown-unknown/release/fortymm_core_wasm.wasm" \
    "$out/$name.raw.wasm"
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$out/$name.raw.wasm" -o "$out/$name.wasm"
  gzip -9 -k -f "$out/$name.wasm"
}

build crypto
build no-crypto --no-default-features

size() { wc -c < "$1" | tr -d ' '; }
echo
echo "WebAssembly size in bytes   cargo build   after wasm-opt -Oz   gzip -9"
for name in crypto no-crypto; do
  printf '%-27s %11s %20s %9s\n' "$name" \
    "$(size "$out/$name.raw.wasm")" "$(size "$out/$name.wasm")" "$(size "$out/$name.wasm.gz")"
done

# The build without cryptography must contain none: no SHA-256 round
# constant (0x428a2f98, little-endian in the data section) and no P-256 field
# prime (its top word 0xffffffff00000001, little-endian).
python3 - "$out/no-crypto.wasm" "$out/crypto.wasm" <<'EOF'
import sys
sha256_k0 = bytes.fromhex("982f8a42")
p256_prime_top = bytes.fromhex("01000000ffffffff")
for path, expect in [(sys.argv[1], False), (sys.argv[2], True)]:
    data = open(path, "rb").read()
    found = sha256_k0 in data or p256_prime_top in data
    print(f"{path}: SHA-256 or P-256 constants {'present' if found else 'absent'}")
    if found != expect:
        sys.exit(f"unexpected for {path}")
EOF
echo

node bindings/wasm/check-vectors.mjs vectors/vectors.json "$out/crypto.wasm" "$out/no-crypto.wasm"
