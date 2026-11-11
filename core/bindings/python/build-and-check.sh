#!/bin/sh
# core:python. Build the Python module (stable ABI, Python 3.12 and later),
# then run the golden vectors through it with the same Python as the api.
#
# Output goes to /opt/core/python in the core-cache volume, not the checkout:
# the module and its type stub. The api's dev container mounts that directory
# (compose.dev.yaml); the api's production image builds its own copy
# (api/Dockerfile).
set -eu

out=/opt/core/python
mkdir -p "$out"
cd /app

cargo build --locked --release --package fortymm-core-python
# Copy, then rename, so a process importing the module never sees half a file.
cp /opt/core/target/release/libfortymm_core.so "$out/.fortymm_core.abi3.so.tmp"
mv "$out/.fortymm_core.abi3.so.tmp" "$out/fortymm_core.abi3.so"
cp bindings/python/fortymm_core.pyi "$out/.fortymm_core.pyi.tmp"
mv "$out/.fortymm_core.pyi.tmp" "$out/fortymm_core.pyi"
echo "Python module: $(wc -c < "$out/fortymm_core.abi3.so" | tr -d ' ') bytes"

PYTHONPATH="$out" python3 bindings/python/check_vectors.py vectors/vectors.json
