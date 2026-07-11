#!/bin/sh
set -eu

# Go's js/wasm ABI has a small argv+environment limit. GitHub-hosted runners
# inject enough variables to exceed it before the test binary starts. Resolve
# the SDK runner first, then execute it with only the variables it needs.
gOROOT=$(go env GOROOT)
exec env -i \
    PATH="${PATH:-/usr/bin:/bin}" \
    HOME="${HOME:-/tmp}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$gOROOT/lib/wasm/go_js_wasm_exec" "$@"
