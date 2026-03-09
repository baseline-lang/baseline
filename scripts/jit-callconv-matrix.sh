#!/usr/bin/env bash
# Run a JIT call-convention validation matrix (Tail vs Fast).
#
# By default:
# - Tail rows are required to pass (baseline behavior gate)
# - Fast rows are informational (for platform validation)
#
# Use --strict to require both Tail and Fast rows to pass.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STRICT=false
SKIP_BUILD=false

usage() {
  cat <<'EOF'
Usage: jit-callconv-matrix.sh [options]

Options:
  --strict      Fail if any Tail/Fast matrix row fails
  --skip-build  Skip release build before running matrix
  -h, --help    Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
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

if [[ "$SKIP_BUILD" == false ]]; then
  echo "Building blc (release)..."
  (cd "$REPO_DIR" && cargo build --quiet --release --bin blc)
fi

run_case() {
  local name="$1"
  local cmd="$2"
  local log
  log="$(mktemp)"

  set +e
  (cd "$REPO_DIR" && bash -lc "$cmd") >"$log" 2>&1
  local code=$?
  set -e

  if [[ $code -eq 0 ]]; then
    echo "[ok]   $name"
  else
    echo "[fail] $name (exit=$code)"
    sed -n '1,120p' "$log"
  fi

  rm -f "$log"
  return "$code"
}

echo "JIT call-convention matrix (Tail vs Fast)"
echo

tail_failed=0
fast_failed=0

if ! run_case \
  "tail: cargo test -p blc --lib jit --quiet" \
  "BLC_JIT_CALL_CONV=tail cargo test -p blc --lib jit --quiet"
then
  tail_failed=1
fi

if ! run_case \
  "tail: hanabi output verification" \
  "BLC_JIT_CALL_CONV=tail ./benchmarks/hanabi/verify_outputs.sh --no-build"
then
  tail_failed=1
fi

if ! run_case \
  "fast: cargo test -p blc --lib jit --quiet" \
  "BLC_JIT_CALL_CONV=fast cargo test -p blc --lib jit --quiet"
then
  fast_failed=1
fi

if ! run_case \
  "fast: hanabi output verification" \
  "BLC_JIT_CALL_CONV=fast ./benchmarks/hanabi/verify_outputs.sh --no-build"
then
  fast_failed=1
fi

echo
echo "Summary:"
echo "  tail_failed=$tail_failed"
echo "  fast_failed=$fast_failed"

if [[ "$STRICT" == true ]]; then
  if [[ $tail_failed -ne 0 || $fast_failed -ne 0 ]]; then
    exit 1
  fi
else
  if [[ $tail_failed -ne 0 ]]; then
    exit 1
  fi
fi

