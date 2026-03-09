#!/usr/bin/env bash
# Verify Baseline Hanabi benchmark outputs against committed reference outputs.
#
# The references live under benchmarks/hanabi/references and are byte-for-byte
# output snapshots for canonical benchmark inputs.
#
# Usage:
#   ./benchmarks/hanabi/verify_outputs.sh
#   ./benchmarks/hanabi/verify_outputs.sh --blc /path/to/blc
#   ./benchmarks/hanabi/verify_outputs.sh --no-build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

BLC="${BLC:-$REPO_DIR/target/release/blc}"
DO_BUILD=true

usage() {
  cat <<'EOF'
Usage: verify_outputs.sh [options]

Options:
  --blc PATH      Path to blc binary (default: target/release/blc)
  --no-build      Do not auto-build blc if missing
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --blc)
      BLC="$2"
      shift 2
      ;;
    --no-build)
      DO_BUILD=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -x "$BLC" ]]; then
  if [[ "$DO_BUILD" == true ]]; then
    echo "Building blc (release)..."
    (cd "$REPO_DIR" && cargo build --quiet --release --bin blc)
  fi
fi

if [[ ! -x "$BLC" ]]; then
  echo "Missing executable blc binary: $BLC" >&2
  exit 1
fi

assert_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing file: $path" >&2
    exit 1
  fi
}

print_mismatch_debug() {
  local expected="$1"
  local actual="$2"
  python3 - "$expected" "$actual" <<'PY'
import hashlib
import pathlib
import sys

exp_path = pathlib.Path(sys.argv[1])
act_path = pathlib.Path(sys.argv[2])
exp = exp_path.read_text()
act = act_path.read_text()

print(f"expected_sha256={hashlib.sha256(exp.encode()).hexdigest()}")
print(f"actual_sha256={hashlib.sha256(act.encode()).hexdigest()}")
print(f"expected_len={len(exp)} actual_len={len(act)}")

for i, (x, y) in enumerate(zip(exp, act)):
    if x != y:
        s = max(0, i - 40)
        e = i + 40
        print(f"first_diff_idx={i}")
        print(f"expected_snip={exp[s:e]!r}")
        print(f"actual_snip  ={act[s:e]!r}")
        break
else:
    if len(exp) != len(act):
        print(f"prefix_equal_length={min(len(exp), len(act))}")
PY
}

check_case() {
  local name="$1"
  local source="$2"
  local input="$3"
  local expected="$4"

  assert_exists "$source"
  assert_exists "$expected"

  local actual
  actual="$(mktemp)"
  "$BLC" run "$source" -- "$input" > "$actual"

  if cmp -s "$expected" "$actual"; then
    echo "[ok] $name (input=$input)"
  else
    echo "[fail] $name (input=$input): output mismatch" >&2
    print_mismatch_debug "$expected" "$actual"
    rm -f "$actual"
    exit 1
  fi

  rm -f "$actual"
}

echo "Verifying Hanabi benchmark outputs..."

check_case \
  "binarytrees" \
  "$SCRIPT_DIR/submission/binarytrees/1.bl" \
  "10" \
  "$SCRIPT_DIR/references/binarytrees/10_out"

check_case \
  "nbody" \
  "$SCRIPT_DIR/submission/nbody/1.bl" \
  "1000" \
  "$SCRIPT_DIR/references/nbody/1000_out"

check_case \
  "fasta" \
  "$SCRIPT_DIR/submission/fasta/1.bl" \
  "1000" \
  "$SCRIPT_DIR/references/fasta/1000_out"

echo "All Hanabi correctness checks passed."

