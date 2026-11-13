#!/bin/sh
# core:python. Build the Python module (stable ABI, Python 3.12 and later),
# then run the golden vectors through it with the same Python as the api.
#
# Output goes to /opt/core/python in the core-cache volume, not the checkout:
# the module and its type stub.
set -eu

out=/opt/core/python
mkdir -p "$out"
cd /app

cargo build --locked --release --package fortymm-core-python
cp /opt/core/target/release/libfortymm_core.so "$out/fortymm_core.abi3.so"
echo "Python module: $(wc -c < "$out/fortymm_core.abi3.so" | tr -d ' ') bytes"

cp bindings/python/fortymm_core.pyi "$out/fortymm_core.pyi"

PYTHONPATH="$out" python3 bindings/python/check_vectors.py vectors/vectors.json \
  bindings/python/fortymm_core.pyi
