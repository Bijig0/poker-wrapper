#!/bin/bash
# Rebuild the WASM solver package (only needed if you change src/lib.rs).
# Output goes to solver-wasm/pkg/, which the TS demo imports directly.
#
# One-time prerequisites:
#   rustup target add wasm32-unknown-unknown
#   curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
set -e
cd "$(dirname "$0")"
wasm-pack build --target nodejs --out-dir pkg --release
echo "Built -> solver-wasm/pkg/  (run: bun run src/demo/liveSolveWasm.ts)"
