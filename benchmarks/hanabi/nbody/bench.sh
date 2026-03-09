#!/usr/bin/env bash
# N-body focused benchmark harness (Baseline vs C reference).
#
# Primary metric target is compiled Baseline binary vs C, but this script also
# tracks current `blc run` performance for continuity while AOT work is in-flight.
#
# Usage:
#   ./benchmarks/hanabi/nbody/bench.sh
#   ./benchmarks/hanabi/nbody/bench.sh --runs 5 --inputs 100000,1000000,5000000
#   ./benchmarks/hanabi/nbody/bench.sh --baseline-bin /path/to/nbody_bl
#   ./benchmarks/hanabi/nbody/bench.sh --save benchmarks/hanabi/nbody/results/latest.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BLC="${BLC:-$REPO_DIR/target/release/blc}"
NBODY_BL="$SCRIPT_DIR/nbody.bl"
NBODY_C_SRC="$SCRIPT_DIR/nbody.c"
NBODY_C_OPT="$SCRIPT_DIR/nbody_c_opt"

RUNS=5
INPUTS_CSV="100000,1000000,5000000"
CHECK_INPUTS_CSV="1000,10000"
SAVE_PATH="$SCRIPT_DIR/results/latest.json"
BASELINE_BIN=""
SKIP_BUILD=false
SKIP_CORRECTNESS=false

usage() {
  cat <<'EOF'
Usage: bench.sh [options]

Options:
  --runs N                 Number of runs per measurement (default: 5)
  --inputs CSV             Benchmark inputs as comma-separated ints
                           (default: 100000,1000000,5000000)
  --check-inputs CSV       Correctness check inputs (default: 1000,10000)
  --save PATH              JSON output path (default: benchmarks/hanabi/nbody/results/latest.json)
  --baseline-bin PATH      Compiled Baseline binary to benchmark (primary metric path)
  --skip-build             Skip rebuilding blc release binary
  --skip-correctness       Skip output equivalence checks against C reference
  -h, --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      RUNS="$2"
      shift 2
      ;;
    --inputs)
      INPUTS_CSV="$2"
      shift 2
      ;;
    --check-inputs)
      CHECK_INPUTS_CSV="$2"
      shift 2
      ;;
    --save)
      SAVE_PATH="$2"
      shift 2
      ;;
    --baseline-bin)
      BASELINE_BIN="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-correctness)
      SKIP_CORRECTNESS=true
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

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [[ "$RUNS" -lt 1 ]]; then
  echo "--runs must be a positive integer" >&2
  exit 1
fi

mkdir -p "$(dirname "$SAVE_PATH")"

if [[ "$SKIP_BUILD" == false ]]; then
  echo "Building blc (release)..."
  (cd "$REPO_DIR" && cargo build --quiet --release --bin blc)
fi

if [[ ! -x "$BLC" ]]; then
  echo "Missing blc binary: $BLC" >&2
  exit 1
fi

if [[ ! -f "$NBODY_C_SRC" ]]; then
  echo "Missing C source: $NBODY_C_SRC" >&2
  exit 1
fi

if [[ ! -x "$NBODY_C_OPT" ]]; then
  echo "Building optimized C reference (nbody_c_opt)..."
  clang -O2 "$NBODY_C_SRC" -lm -o "$NBODY_C_OPT"
fi

if [[ -n "$BASELINE_BIN" && ! -x "$BASELINE_BIN" ]]; then
  echo "Baseline compiled binary is not executable: $BASELINE_BIN" >&2
  exit 1
fi

python3 - "$RUNS" "$INPUTS_CSV" "$CHECK_INPUTS_CSV" "$SAVE_PATH" "$BLC" "$NBODY_BL" "$NBODY_C_OPT" "$BASELINE_BIN" "$SKIP_CORRECTNESS" <<'PY'
import json
import platform
import shlex
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

runs = int(sys.argv[1])
inputs = [int(x) for x in sys.argv[2].split(",") if x.strip()]
check_inputs = [int(x) for x in sys.argv[3].split(",") if x.strip()]
save_path = Path(sys.argv[4])
blc = sys.argv[5]
nbody_bl = sys.argv[6]
c_opt = sys.argv[7]
baseline_bin = sys.argv[8]
skip_correctness = sys.argv[9].lower() == "true"

def cmd_source(n: int) -> str:
    return f"{shlex.quote(blc)} run {shlex.quote(nbody_bl)} -- {n}"

def cmd_c_opt(n: int) -> str:
    return f"{shlex.quote(c_opt)} {n}"

def cmd_compiled(n: int) -> str:
    return f"{shlex.quote(baseline_bin)} {n}"

def run_capture(cmd: str) -> str:
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {cmd}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc.stdout.strip()

def run_timed(cmd: str, count: int) -> tuple[float, float, float]:
    times = []
    for _ in range(count):
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if proc.returncode != 0:
            raise RuntimeError(f"Timing command failed ({proc.returncode}): {cmd}")
        times.append(time.perf_counter() - t0)
    return statistics.median(times), min(times), max(times)

if not skip_correctness:
    print("Running correctness checks...")
    for n in check_inputs:
        c_out = run_capture(cmd_c_opt(n))
        src_out = run_capture(cmd_source(n))
        if src_out != c_out:
            raise RuntimeError(
                f"Correctness mismatch for blc run at input {n}\n"
                f"Baseline source output:\n{src_out}\n"
                f"C output:\n{c_out}"
            )
        if baseline_bin:
            bin_out = run_capture(cmd_compiled(n))
            if bin_out != c_out:
                raise RuntimeError(
                    f"Correctness mismatch for compiled baseline at input {n}\n"
                    f"Compiled output:\n{bin_out}\n"
                    f"C output:\n{c_out}"
                )
    print("  correctness: OK")

rows: list[dict] = []
print(f"Timing nbody (runs={runs}, inputs={inputs})")

for n in inputs:
    c_med, c_min, c_max = run_timed(cmd_c_opt(n), runs)
    rows.append(
        {
            "variant": "c_opt",
            "input": n,
            "time_s": round(c_med, 6),
            "min_s": round(c_min, 6),
            "max_s": round(c_max, 6),
            "ratio_vs_c_opt": 1.0,
        }
    )

    src_med, src_min, src_max = run_timed(cmd_source(n), runs)
    rows.append(
        {
            "variant": "baseline_source",
            "input": n,
            "time_s": round(src_med, 6),
            "min_s": round(src_min, 6),
            "max_s": round(src_max, 6),
            "ratio_vs_c_opt": round(src_med / c_med, 3),
        }
    )

    if baseline_bin:
        bin_med, bin_min, bin_max = run_timed(cmd_compiled(n), runs)
        rows.append(
            {
                "variant": "baseline_compiled",
                "input": n,
                "time_s": round(bin_med, 6),
                "min_s": round(bin_min, 6),
                "max_s": round(bin_max, 6),
                "ratio_vs_c_opt": round(bin_med / c_med, 3),
            }
        )

data = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "system": f"{platform.machine()} {platform.system()} {platform.release()}",
    "runs": runs,
    "inputs": inputs,
    "correctness_inputs": [] if skip_correctness else check_inputs,
    "baseline_compiled_enabled": bool(baseline_bin),
    "commands": {
        "baseline_source": f"{blc} run {nbody_bl} -- <N>",
        "baseline_compiled": (f"{baseline_bin} <N>" if baseline_bin else None),
        "c_opt": f"{c_opt} <N>",
    },
    "results": rows,
}

save_path.parent.mkdir(parents=True, exist_ok=True)
save_path.write_text(json.dumps(data, indent=2) + "\n")

md_path = save_path.with_suffix(".md")
lines = [
    "# N-body Benchmark Results",
    "",
    f"**Date:** {data['timestamp']}",
    f"**System:** {data['system']}",
    f"**Runs:** {runs} (median)",
    "",
    "| Input | Variant | Median (s) | Min (s) | Max (s) | vs c_opt |",
    "|-------|---------|------------|---------|---------|----------|",
]

for n in inputs:
    group = [r for r in rows if r["input"] == n]
    order = {"c_opt": 0, "baseline_source": 1, "baseline_compiled": 2}
    group.sort(key=lambda r: order.get(r["variant"], 99))
    for r in group:
        lines.append(
            f"| {n} | {r['variant']} | {r['time_s']:.6f} | {r['min_s']:.6f} | {r['max_s']:.6f} | {r['ratio_vs_c_opt']:.3f}x |"
        )

md_path.write_text("\n".join(lines) + "\n")

print("")
print("Summary:")
for n in inputs:
    group = [r for r in rows if r["input"] == n]
    c = next(r for r in group if r["variant"] == "c_opt")
    src = next(r for r in group if r["variant"] == "baseline_source")
    print(
        f"  N={n}: baseline_source={src['time_s']:.6f}s, c_opt={c['time_s']:.6f}s, ratio={src['ratio_vs_c_opt']:.3f}x"
    )
    if baseline_bin:
        comp = next(r for r in group if r["variant"] == "baseline_compiled")
        print(
            f"       baseline_compiled={comp['time_s']:.6f}s, ratio={comp['ratio_vs_c_opt']:.3f}x"
        )

print("")
print(f"Saved JSON: {save_path}")
print(f"Saved Markdown: {md_path}")
PY
