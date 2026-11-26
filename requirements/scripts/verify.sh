#!/usr/bin/env bash
# Verify the given .dfy files, or every requirement spec when none are given.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  mapfile -t files < <(find . -name '*.dfy' | sort)
else
  files=("$@")
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "No .dfy files found in requirements/" >&2
  exit 1
fi

exec dafny verify \
  --allow-warnings \
  "${files[@]}"
