#!/usr/bin/env bash
# Run heap-heavy Baseline benchmarks with runtime + memory-pressure regression gates.
#
# This script is intended for BEFORE and AFTER optimization checks.
# It tracks:
#   - runtime median (performance)
#   - RSS (memory pressure)
#   - RC allocation counters from --mem-stats (allocs/frees/reuses/live)
#   - benchmark output (correctness guard)
#
# Usage:
#   ./benchmarks/cpu/bench_heap.sh          # Run all heap-focused benchmarks
#   ./benchmarks/cpu/bench_heap.sh tak      # Run one benchmark
#   ./benchmarks/cpu/bench_heap.sh --save   # Save/update heap baseline reference
#
# Threshold env overrides:
#   RUNS=3
#   TIME_REGRESSION_PCT=10
#   MEM_REGRESSION_PCT=15
#   ALLOCS_REGRESSION_PCT=15
#   REUSE_DROP_REGRESSION_PCT=10

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
REFERENCE="$RESULTS_DIR/heap_reference.json"
MARKDOWN="$RESULTS_DIR/heap_reference.md"

RUNS="${RUNS:-3}"
TIME_REGRESSION_PCT="${TIME_REGRESSION_PCT:-10}"
MEM_REGRESSION_PCT="${MEM_REGRESSION_PCT:-15}"
ALLOCS_REGRESSION_PCT="${ALLOCS_REGRESSION_PCT:-15}"
REUSE_DROP_REGRESSION_PCT="${REUSE_DROP_REGRESSION_PCT:-10}"

BENCHES=(mapbuild treemap mergesort strrev tak)
LANG_LABEL="baseline_jit"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SAVE_MODE=false
FILTER=""
for arg in "$@"; do
    case "$arg" in
        --save) SAVE_MODE=true ;;
        *) FILTER="$arg" ;;
    esac
done

if [ -n "$FILTER" ]; then
    found=false
    for bench in "${BENCHES[@]}"; do
        if [ "$bench" = "$FILTER" ]; then
            found=true
            break
        fi
    done
    if [ "$found" != "true" ]; then
        echo -e "${RED}Unknown benchmark '${FILTER}'.${NC} Valid: ${BENCHES[*]}"
        exit 1
    fi
fi

mkdir -p "$RESULTS_DIR"

echo -e "${CYAN}Building blc (release)...${NC}"
(cd "$REPO_DIR" && cargo build --release --bin blc >/dev/null)
BLC="$REPO_DIR/target/release/blc"

echo -e "${BOLD}Heap Benchmark Gate${NC}"
echo "==================="
echo "Runs: $RUNS"
echo "Thresholds: time +${TIME_REGRESSION_PCT}% | RSS +${MEM_REGRESSION_PCT}% | allocs +${ALLOCS_REGRESSION_PCT}% | reuses drop ${REUSE_DROP_REGRESSION_PCT}%"
echo "Reference: $REFERENCE"
echo ""

# Fast smoke check so failures are obvious before long runs.
SMOKE_OUT=$("$BLC" run "$SCRIPT_DIR/fib/fib.bl" 2>/dev/null || true)
if [ "$SMOKE_OUT" != "9227465" ]; then
    echo -e "${RED}blc run smoke check failed (fib expected 9227465).${NC}"
    exit 1
fi

measure_time_s() {
    local file="$1"
    python3 - "$BLC" "$file" "$RUNS" <<'PY'
import statistics, subprocess, sys, time

blc, path, runs = sys.argv[1], sys.argv[2], int(sys.argv[3])
times = []
for _ in range(runs):
    start = time.perf_counter()
    proc = subprocess.run([blc, "run", path], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    times.append(time.perf_counter() - start)
print(f"{statistics.median(times):.3f}")
PY
}

measure_mem_kb() {
    local file="$1"
    local mem_output mem_kb
    mem_output=$(/usr/bin/time -l "$BLC" run "$file" 2>&1 >/dev/null || true)
    mem_kb=$(echo "$mem_output" | awk '/maximum resident set size/{print int($1/1024)}')
    if [ -z "$mem_kb" ]; then
        mem_kb=0
    fi
    echo "$mem_kb"
}

measure_mem_stats() {
    local file="$1"
    local stats_output
    stats_output=$("$BLC" run --mem-stats "$file" 2>&1 >/dev/null || true)
    python3 - "$stats_output" <<'PY'
import re, sys
text = sys.argv[1]
line = None
for l in text.splitlines():
    if l.startswith("[mem] "):
        line = l
        break
if line is None:
    print("0 0 0 0")
    raise SystemExit(0)
m = re.search(r"allocs:\s*(\d+)\s+frees:\s*(\d+)\s+reuses:\s*(\d+)\s+live:\s*(\d+)", line)
if not m:
    print("0 0 0 0")
    raise SystemExit(0)
print(" ".join(m.groups()))
PY
}

collect_output() {
    local file="$1"
    local output
    if ! output=$("$BLC" run "$file" 2>/dev/null); then
        echo ""
        return 1
    fi
    echo "$output" | python3 -c 'import sys; print(sys.stdin.read().strip())'
}

encode_b64() {
    printf "%s" "$1" | base64 | tr -d '\n'
}

json_entry() {
    local bench="$1" time_s="$2" mem_kb="$3" allocs="$4" frees="$5" reuses="$6" live="$7" output_b64="$8"
    python3 - "$bench" "$time_s" "$mem_kb" "$allocs" "$frees" "$reuses" "$live" "$output_b64" <<'PY'
import base64, json, sys
bench, time_s, mem_kb, allocs, frees, reuses, live, out_b64 = sys.argv[1:]
out = base64.b64decode(out_b64.encode()).decode("utf-8")
obj = {
    "lang": "baseline_jit",
    "bench": bench,
    "time_s": float(time_s),
    "mem_kb": int(mem_kb),
    "allocs": int(allocs),
    "frees": int(frees),
    "reuses": int(reuses),
    "live": int(live),
    "output": out,
}
print(json.dumps(obj, separators=(",", ":")))
PY
}

compare_with_reference() {
    local bench="$1" time_s="$2" mem_kb="$3" allocs="$4" reuses="$5" output_b64="$6"
    python3 - "$REFERENCE" "$bench" "$time_s" "$mem_kb" "$allocs" "$reuses" "$output_b64" \
        "$TIME_REGRESSION_PCT" "$MEM_REGRESSION_PCT" "$ALLOCS_REGRESSION_PCT" "$REUSE_DROP_REGRESSION_PCT" <<'PY'
import base64, json, sys

(
    ref_file,
    bench,
    cur_time,
    cur_mem,
    cur_allocs,
    cur_reuses,
    cur_out_b64,
    t_thr,
    m_thr,
    a_thr,
    r_thr,
) = sys.argv[1:]

cur_time = float(cur_time)
cur_mem = float(cur_mem)
cur_allocs = float(cur_allocs)
cur_reuses = float(cur_reuses)
cur_out = base64.b64decode(cur_out_b64.encode()).decode("utf-8")
t_thr = float(t_thr)
m_thr = float(m_thr)
a_thr = float(a_thr)
r_thr = float(r_thr)

with open(ref_file) as f:
    data = json.load(f)

ref = None
for row in data.get("results", []):
    if row.get("lang") == "baseline_jit" and row.get("bench") == bench:
        ref = row
        break

if ref is None:
    print("NOREF\t(no reference entry)")
    raise SystemExit(0)

def pct(cur, ref):
    if not ref:
        return 0.0
    return ((cur - ref) / ref) * 100.0

time_pct = pct(cur_time, float(ref.get("time_s", 0.0)))
mem_pct = pct(cur_mem, float(ref.get("mem_kb", 0.0)))
alloc_pct = pct(cur_allocs, float(ref.get("allocs", 0.0)))
reuse_pct = pct(cur_reuses, float(ref.get("reuses", 0.0)))

ref_reuses = float(ref.get("reuses", 0.0))
reuse_drop_pct = ((ref_reuses - cur_reuses) / ref_reuses * 100.0) if ref_reuses > 0 else 0.0

reasons = []
if time_pct > t_thr:
    reasons.append(f"time +{time_pct:.1f}%")
if mem_pct > m_thr:
    reasons.append(f"rss +{mem_pct:.1f}%")
if alloc_pct > a_thr:
    reasons.append(f"allocs +{alloc_pct:.1f}%")
if reuse_drop_pct > r_thr:
    reasons.append(f"reuses drop {reuse_drop_pct:.1f}%")

ref_out = ref.get("output")
if isinstance(ref_out, str) and ref_out != cur_out:
    reasons.append("output mismatch")

summary = f"time {time_pct:+.1f}% | rss {mem_pct:+.1f}% | allocs {alloc_pct:+.1f}% | reuses {reuse_pct:+.1f}%"
if reasons:
    print("REGRESSION\t" + summary + " | " + ", ".join(reasons))
else:
    print("OK\t" + summary)
PY
}

ENTRIES=()
HAS_REGRESSION=false
RAN_ANY=false

run_bench() {
    local bench="$1"
    local file="$SCRIPT_DIR/$bench/$bench.bl"

    printf "%-10s " "$bench"

    local output time_s mem_kb stats allocs frees reuses live output_b64
    output=$(collect_output "$file")
    output_b64=$(encode_b64 "$output")
    time_s=$(measure_time_s "$file")
    mem_kb=$(measure_mem_kb "$file")
    stats=$(measure_mem_stats "$file")
    read -r allocs frees reuses live <<<"$stats"

    printf "${GREEN}%8ss${NC}  %6s KB  alloc:%-8s frees:%-8s reuse:%-8s live:%-8s" \
        "$time_s" "$mem_kb" "$allocs" "$frees" "$reuses" "$live"

    if [ -f "$REFERENCE" ] && [ "$SAVE_MODE" != "true" ]; then
        local cmp status msg
        cmp=$(compare_with_reference "$bench" "$time_s" "$mem_kb" "$allocs" "$reuses" "$output_b64")
        status="${cmp%%$'\t'*}"
        msg="${cmp#*$'\t'}"
        case "$status" in
            REGRESSION)
                HAS_REGRESSION=true
                printf "  ${RED}%s${NC}" "$msg"
                ;;
            OK)
                printf "  %s" "$msg"
                ;;
            *)
                printf "  ${YELLOW}%s${NC}" "$msg"
                ;;
        esac
    fi
    printf "\n"

    ENTRIES+=("$(json_entry "$bench" "$time_s" "$mem_kb" "$allocs" "$frees" "$reuses" "$live" "$output_b64")")
}

echo -e "${CYAN}Running heap-focused benchmarks...${NC}"
echo ""

for bench in "${BENCHES[@]}"; do
    if [ -n "$FILTER" ] && [ "$FILTER" != "$bench" ]; then
        continue
    fi
    run_bench "$bench"
    RAN_ANY=true
done

if [ "$RAN_ANY" != "true" ]; then
    echo -e "${RED}No benchmarks executed.${NC}"
    exit 1
fi

if [ "$SAVE_MODE" = "true" ]; then
    TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    SYSTEM_ID="$(uname -m) $(uname -s) $(sw_vers -productVersion 2>/dev/null || uname -r)"

    python3 - "$REFERENCE" "$TIMESTAMP" "$SYSTEM_ID" "$RUNS" "${ENTRIES[@]}" <<'PY'
import json, os, sys

ref_file = sys.argv[1]
timestamp = sys.argv[2]
system_id = sys.argv[3]
runs = int(sys.argv[4])
new_rows = [json.loads(x) for x in sys.argv[5:]]

if os.path.exists(ref_file):
    with open(ref_file) as f:
        data = json.load(f)
else:
    data = {"results": []}

existing = {}
for row in data.get("results", []):
    key = (row.get("lang"), row.get("bench"))
    existing[key] = row

for row in new_rows:
    existing[(row.get("lang"), row.get("bench"))] = row

merged = [existing[k] for k in sorted(existing.keys(), key=lambda t: (t[0], t[1]))]
data = {
    "timestamp": timestamp,
    "system": system_id,
    "runs": runs,
    "results": merged,
}

with open(ref_file, "w") as f:
    json.dump(data, f, indent=2)
print(ref_file)
PY

    python3 - "$REFERENCE" "$MARKDOWN" <<'PY'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

rows = [r for r in data.get("results", []) if r.get("lang") == "baseline_jit"]
rows.sort(key=lambda r: r["bench"])

lines = []
lines.append("# Heap Benchmark Reference Results")
lines.append("")
lines.append(f"**Date:** {data.get('timestamp', 'unknown')}")
lines.append(f"**System:** {data.get('system', 'unknown')}")
lines.append(f"**Runs:** {data.get('runs', '?')} (median)")
lines.append("")
lines.append("| Benchmark | Time (s) | RSS (KB) | Allocs | Frees | Reuses | Live | Output |")
lines.append("|-----------|----------|----------|--------|-------|--------|------|--------|")
for r in rows:
    out = str(r.get("output", "")).replace("\n", " ").strip()
    if len(out) > 42:
        out = out[:39] + "..."
    lines.append(
        f"| {r.get('bench')} | {float(r.get('time_s', 0.0)):.3f} | {int(r.get('mem_kb', 0))} | "
        f"{int(r.get('allocs', 0))} | {int(r.get('frees', 0))} | {int(r.get('reuses', 0))} | "
        f"{int(r.get('live', 0))} | `{out}` |"
    )

with open(sys.argv[2], "w") as f:
    f.write("\n".join(lines) + "\n")
print(sys.argv[2])
PY

    echo ""
    echo -e "${GREEN}Saved heap baseline:${NC} $REFERENCE"
    echo -e "${GREEN}Saved heap markdown:${NC} $MARKDOWN"
fi

echo ""
if [ "$HAS_REGRESSION" = "true" ]; then
    echo -e "${RED}Heap benchmark regression detected.${NC}"
    exit 1
fi

echo -e "${GREEN}Heap benchmarks within thresholds.${NC}"
exit 0
