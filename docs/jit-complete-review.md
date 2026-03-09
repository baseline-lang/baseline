# Baseline JIT Comprehensive Review (2026-03-08, revised)

This revision incorporates maintainer feedback and corrects inaccuracies in the initial draft.

## Executive summary

Baseline's JIT is materially more capable than older top-level review artifacts indicate, and the core direction (JIT-first runtime, RC/reuse-aware semantics) is sound.

The most important outcomes from this review are:

1. stale JIT docs must be treated as historical, not authoritative;
2. `fasta` correctness reference mismatch still needs hard resolution; and
3. the biggest short-term performance wins are in existing optimization work (SRA expansion, RC elision coverage, loop/tail paths), not in introducing tier-2 JIT machinery.

Documentation policy:
- Treat this file as the maintained JIT review snapshot.
- Treat older RFC/review artifacts as historical context unless they are explicitly refreshed.

---

## Corrections to the prior draft

## 1) Calling-convention statement corrected

The previous draft stated "JIT compiles with `CallConv::Tail`" as if it were the full story.  
The source actually shows a **mixed policy**:

- JIT internal signatures/wrappers/trampolines are currently Tail CC (`blc/src/vm/jit/mod.rs`).
- AOT explicitly uses Fast CC with a comment documenting macOS aarch64 Tail-CC issues on Cranelift 0.128 (`blc/src/vm/jit/aot.rs`).

So the accurate statement is: **Tail is used in JIT today, but Fast is used in AOT due a known platform issue; this policy split should be reconciled and validated explicitly on macOS aarch64.**

## 2) BinOp gating severity reduced

`analysis.rs::expr_can_jit` is structurally permissive for `Expr::BinOp`, but this is downstream of type checking.  
Treating this as a medium-high correctness risk was overstated; it is better framed as a **low-priority defensive hardening option**, not a central issue.

## 3) VM fallback framing corrected

`run_file_jit` exits on JIT compile/run errors and does not dispatch to VM fallback, but this aligns with the JIT-first direction and the long-term "JIT-only runtime" aspiration documented in `design/rfc-100-percent-jit.md`.  
The right recommendation is to increase JIT coverage and diagnostics, not to invest in preserving VM fallback paths.

## 4) Float unboxed policy clarified as intentional

The prior draft described Float scalar/unboxed behavior as an inconsistency.  
In practice, current constraints are intentional safety boundaries:

- unboxed candidate selection excludes `Bool`/`Float` returns (`analysis.rs::compute_unboxed_flags`);
- entry is kept boxed to preserve NaN-boxed ABI expectations.

Given NaN-boxing sentinels and generic entry/wrapper boundaries, this should be documented as a **deliberate safety rule**, not an oversight.

## 5) Prior-art section narrowed

The earlier BEAM/PyPy/JVM comparison was too generic.  
This revision keeps only prior-art points that map directly to concrete Baseline decisions.

---

## Source-verified architecture snapshot

## Pipeline

1. Front-end: parse -> type/effect/refinement checks -> IR lower -> `optimize_ir`.
2. JIT compile (`jit::compile_with_natives`): helper symbol registration, `can_jit`, unboxed flags, multireturn analysis, Cranelift codegen.
3. Execute (`JitProgram::run_entry_nvalue`): install dispatch/trampolines, run entry, surface JIT error slot, cleanup arena/RC mode.

## Runtime ownership modes

`baseline-rt/src/helpers.rs` uses two explicit modes:

- **arena mode** (`jit_own` + `jit_arena_drain`) for bounded execution-lifetime retention;
- **RC mode** (`jit_set_rc_mode_raw`, explicit incref/decref helpers) for deterministic ownership.

---

## High-impact optimizations already implemented (and should be expanded)

## 1) SRA (Scalar Replacement of Aggregates)

Implemented across `compile_opt.rs` and `compile.rs`:

- record/struct let-binding interception into field SSA vars (`try_compile_sra_let`);
- escape-aware candidate selection (`find_sra_candidates_with_existing`);
- parameter field cache seeding (`seed_param_field_cache`);
- SRA-aware self-tail-call rebinding to avoid rematerializing boxed records (`compile_sra_tail_call`).

Coverage also exists in tests (for example `blc/src/vm/jit/tests_pattern.rs` SRA tests).

## 2) Scalar RC elision

`compile.rs` tracks scalar values (`scalar_values`) and elides RC operations for Int/Float/Bool/Unit in `emit_incref` / `emit_decref`.  
This is a real, already-shipped optimization and a major foundation for low-overhead RC semantics.

## 3) Base-case speculation

`try_speculate_call` and `try_speculate_call_unboxed` speculatively inline simple recursive base cases, short-circuiting full call overhead on hot recursive functions.

## 4) Self-tail-call to loop lowering

Self-recursive tail calls are compiled to loop-header jumps (with param rebinding), including SRA-aware fast paths, eliminating recursive call growth and reducing allocation churn in loop-heavy code.

---

## Fresh validation snapshot

- `cargo test -p blc --lib jit --quiet`: **87 passed, 0 failed, 17 ignored**.
- `nbody` output (`n=1000`) matches optimized C reference in-repo.
- `binary-trees` output (`n=10`) matches in-repo C reference.
- `fasta` output (`n=1000`) still mismatches in-repo C reference.
- `benchmarks/hanabi/nbody/bench.sh` (`runs=3`, `input=100000`):
  - baseline_source: **0.143490s**
  - c_opt: **0.013575s**
  - ratio: **10.57x**

RSS spot checks (`/usr/bin/time -l`) were also captured for binary-trees/fasta/nbody.

---

## Re-prioritized findings

## P0: trust and correctness gates

1. **Documentation drift** remains a top problem: older review files contradict live code/tests.
2. **Fasta benchmark truth source** must be finalized (authoritative reference output files, then CI gating).
3. **Calling convention policy split (Tail in JIT, Fast in AOT)** should be explicitly validated on macOS aarch64 and codified.

## P1: performance work that moves the needle now

1. Expand SRA coverage (especially chained updates + wider non-escaping cases).
2. Broaden scalar RC elision opportunities and tighten RC helper traffic in hot blocks.
3. Push more hot arithmetic/control paths onto direct Cranelift ops where semantics allow.
4. Improve loop optimization around tail-recursive kernels before considering multi-tier complexity.

## P2: optional hardening

1. Keep BinOp type checks in `analysis.rs` as optional defensive verification (low priority).
2. Improve unsupported-construct diagnostics to speed JIT coverage expansion.

---

## Interpreting the 10.57x nbody gap

The ratio should not be read as "JIT is fundamentally off-track"; it mostly indicates remaining optimization headroom in already-implemented architecture.

Current evidence points to likely contributors:

- helper-bound hot operations in several numeric/structural paths;
- NaN-boxing/tagging boundary costs across boxed/unboxed transitions;
- call/ABI overhead in recursive and indirect-call heavy regions;
- optimization gaps still open in SRA/loop/inline heuristics.

Important caveat: `--mem-stats` in release builds always reports zeros by design (`baseline-rt/src/nvalue.rs`), so release runs cannot currently be used to attribute the gap to allocation counts.  
If allocation pressure is to be quantified for release profiling, dedicated JIT/runtime counters are needed.

---

## Prior-art relevance (Baseline-specific only)

Only two external patterns are directly actionable right now:

1. **Koka/Perceus lineage:** ownership/reuse reasoning should continue to drive RC + `Drop/Reuse` + SRA decisions (this is already where Baseline has real leverage).
2. **Functional runtime representation discipline (OCaml/Rust-style lessons):** keep investing in value representation and data-layout-aware optimizations before introducing higher-complexity JIT tiers.

Generic comparisons to tracing JITs or tiered VM stacks are lower-value until current low-level wins are exhausted.

---

## Practical roadmap (updated)

## Phase 1 (immediate)

1. [done] Resolve benchmark truth source for `fasta` (authoritative outputs + byte-for-byte checks via `benchmarks/hanabi/references/*` and `benchmarks/hanabi/verify_outputs.sh`).
2. [done] Consolidate stale JIT docs into this maintained review (historical RFCs now explicitly point here for current status).
3. [done] Add a focused macOS aarch64 calling-convention validation matrix (Tail vs Fast in JIT path) via `scripts/jit-callconv-matrix.sh`.

## Phase 2 (near-term performance)

1. Expand SRA candidate and tail-rebind coverage.
2. Extend scalar RC elision and reduce redundant helper traffic.
3. Improve base-case speculation applicability and loop hot-path lowering.
4. [done] Add release-safe counters for helper-call frequency and boxed/unboxed boundary crossings (`BLC_JIT_COUNTERS=1` + `--mem-stats`).

## Phase 3 (later, only if needed)

Re-evaluate tiered recompile strategy **after** Phase 2 gains are measured; do not treat tiering as the default next step.

---

## Acceptance criteria for next milestone

1. `cargo test -p blc --lib jit` remains green.
2. nbody/binary-trees/fasta correctness is gated against committed reference outputs.
3. JIT docs match code for:
   - calling convention policy,
   - supported IR constructs,
   - unboxed safety rules (including Float return constraint),
   - JIT-only runtime behavior.
4. Perf tracking includes at least:
   - one compute-heavy kernel (nbody),
   - one allocation-heavy structure benchmark (binary-trees),
   - one string/IO-heavy benchmark (fasta),
   with release-safe instrumentation for helper/boxing overhead.

---

## Final assessment

Baseline's JIT is stronger than stale artifacts suggest, and the right next work is concrete optimizer/runtime improvement, not process overhead.  
The highest-leverage path is to finish benchmark correctness gates, lock down platform call-conv behavior, and deepen SRA/RC/loop optimizations already present in the codebase.
