#!/usr/bin/env bash
# Build the runtime payload, the native library and run both harnesses.
set -euo pipefail
cd "$(dirname "$0")/.."

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"
ctest --test-dir build --output-on-failure

echo
echo "artifacts:"
ls -l build/oicq.so
