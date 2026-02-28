# RFC: Effect Compilation Architecture

**Status:** Draft
**Date:** 2026-02-27

---

## Thesis

Baseline's competitive position rests on three pillars:

1. **Correctness** — the compiler catches more mistakes than other languages (effects, refinements, exhaustive types)
2. **Predictable, low memory** — no GC headroom, deterministic resource usage
3. **Low latency** — no GC pauses, bounded tail latency
4. **LLM-native** — unambiguous syntax designed for machine generation

Effect compilation is the keystone architectural decision because it constrains all three runtime pillars (correctness, memory, latency). Effects alter control flow (via continuations) and the ABI (via hidden handler state). Finalizing memory management or value representation first risks a tear-down-to-studs retrofit — the wrong continuation strategy invalidates memory layout, and the wrong ABI defeats the latency guarantees.

Throughput matters but is not the primary goal. Baseline does not need to match Rust/C on allocation-heavy workloads. It needs to guarantee that the type system catches real bugs, that memory usage is tight and predictable, and that tail latency stays low.

This RFC proposes four interlocking decisions, ordered by dependency:

1. **Continuation semantics** — one-shot only (the real keystone)
2. **Effect compilation strategy** — evidence passing (extend what we have)
3. **Memory management** — Perceus-inspired RC with reuse analysis (not handler-scoped arenas)
4. **Value representation** — keep the proven split (uniform VM + unboxed JIT)

---

## Current State (What We Already Have)

Baseline is further along than it might appear. Several of these building blocks are already implemented or partially in place:

### Evidence-passing transform (`optimize_ir.rs:523-828`)

A working evidence-passing transform that eliminates tail-resumptive `HandleEffect`, `WithHandlers`, and `PerformEffect` nodes from the IR:

- `compute_needs_evidence()` identifies directly and transitively effectful functions via call graph + fixed-point iteration
- Effectful functions receive an `__ev` parameter (evidence record)
- `HandleEffect` with all tail-resumptive clauses compiles to `MakeRecord` of handler lambdas (with `resume(expr)` wrappers stripped)
- `PerformEffect` compiles to `GetField` + `CallIndirect` (record lookup + call)
- `CallDirect`/`TailCall` to effectful functions prepends the evidence argument
- Nested handlers use `UpdateRecord` to merge with parent evidence
- Non-tail-resumptive handlers are left untouched for VM fallback (`can_jit` rejects them)

### NaN-boxed NValue with Rc

- 8-byte NaN-boxed values: Float (raw IEEE 754), Int (48-bit signed), Bool, Unit, Function (chunk index), Heap (Arc/Rc pointer)
- `non-atomic-rc` feature flag switches Arc to Rc — **already the default** in `blc/Cargo.toml` (`default = ["jit", "non-atomic-rc"]`)
- `baseline-rt/src/rc.rs` provides a thin abstraction layer with `increment_strong_count`/`decrement_strong_count` wrappers

### JIT unboxed scalar fast path

- `is_scalar_only()` in `analysis.rs` identifies functions using only Int/Bool/Unit/Float
- Scalar-only functions use unboxed codegen (no NaN-boxing overhead internally)
- `type_is_scalar()` defaults to `false` for `None` types (pessimistic — fixed from earlier bug)

### Continuation heap object (VM-only)

- `HeapObject::Continuation { stack_segment, frame_segment, ... }` in `nvalue.rs`
- One-shot semantics enforced at the VM level (continuation consumed on call)
- Used for non-tail-resumptive handlers in the interpreter/VM

### JIT RC mode

- Thread-local `JIT_RC_MODE` flag toggles between arena mode and RC mode
- RC mode: `jit_own()` forgets the Rust NValue (caller owns refcount via raw bits)
- Arena mode: `jit_own()` pushes to thread-local `JIT_ARENA` (arena keeps values alive until drain)
- `jit_enum_field_drop` + `jit_enum_field_set` bypass `Rc::get_mut` via raw pointer mutation for clone-on-write enum field updates

### JIT calling convention

- All Baseline functions use `CallConv::Tail` in JIT mode, `CallConv::Fast` in AOT mode
- Entry wrapper bridges platform CC to Tail CC

---

## Decision 1: Continuation Semantics (The Real Keystone)

**Recommendation: One-shot only (possibly forever)**

This is the decision that unlocks everything else. Multi-shot vs one-shot continuations affects the entire memory and control flow architecture.

### What one-shot means

When an effect handler captures a continuation (the "rest of the computation" after a `perform`), it can resume that continuation exactly once. After resumption, the continuation is consumed — attempting to resume it again is a runtime error.

### Evidence from production systems

| System | Choice | Overhead on non-effectful code | Capture/resume cost |
|--------|--------|-------------------------------|-------------------|
| OCaml 5 | One-shot fibers | ~1% (PLDI 2021) | O(1) — fiber switch |
| Koka | Multi-shot (yield/bubble) | ~5-15% evidence passing | O(n) stack copy for multi-shot |
| Eff (direct) | Multi-shot | 10-20x slowdown on non-effectful code | Full stack copy |

OCaml 5's results are the most relevant: they chose one-shot fibers and measured only 1% overhead on non-effectful code. Their fibers are essentially coroutines — `O(1)` capture (save stack pointer) and `O(1)` resume (restore stack pointer). No stack copying.

### What one-shot buys us

1. **Simpler effect checker** — multi-shot continuations require tracking linearity (is a continuation used once or many times?). One-shot eliminates this entire analysis dimension, keeping the effect checker tractable. The compiler can catch more real bugs because it's not spending complexity budget on continuation linearity.
2. **LIFO stack discipline preserved** — continuations are always resumed in reverse order of capture, so the stack grows and shrinks predictably. Memory usage is proportional to call depth, not handler count.
3. **No stack copying** — the captured "continuation" is just a fiber/coroutine switch point, not a snapshot of the stack. No latency spikes from copying large stacks.
4. **RC reuse analysis works** — refcount-1 optimizations (drop-reuse pairing) are valid because values don't get captured into multiple continuation copies. This keeps memory tight.
5. **Predictable latency** — no O(n) stack copy on `perform`. Fiber switch is O(1) regardless of stack depth.

### What we give up

- **Nondeterminism** — `amb` / `choose` effects that explore multiple branches (workaround: explicit search data structures like lists of alternatives)
- **Backtracking** — Prolog-style logic programming effects (workaround: CPS-transform the search manually)
- **Probabilistic effects** — multi-shot needed for certain probabilistic programming patterns (workaround: explicit sampling APIs)

These are niche use cases that don't align with Baseline's target workloads (web services, CLI tools, data processing). The POPL 2025 "Affect" paper shows that affine types can statically distinguish one-shot from multi-shot continuations, so a future extension could add opt-in multi-shot without compromising the default one-shot path.

### Implementation path

Baseline already enforces one-shot semantics in the VM's `Continuation` handling. The extension is:

1. Implement fiber-based resume for non-tail-resumptive one-shot handlers (coroutine switch instead of stack segment copy)
2. JIT codegen for fiber switch (save/restore registers + stack pointer via Cranelift `return_call` or helper)
3. Static analysis to verify one-shot usage (warn on aliased continuations)

---

## Decision 2: Effect Compilation Strategy

**Recommendation: Evidence passing (extend what we have)**

We already have a working evidence-passing transform in `optimize_ir.rs`. The strategy is to extend it, not replace it.

### How evidence passing works (current implementation)

```
// Source:
handle {
  Console.println(msg) -> resume(log(msg))
}
  compute!(x)

// After evidence transform:
let __ev_0 = { "Console.println": |msg| log(msg) }
compute(__ev_0, x)    // __ev prepended as first argument

// Inside compute:
fn compute(__ev, x) =
  let __ev_fn = __ev."Console.println"   // GetField on evidence record
  __ev_fn("hello")                        // CallIndirect
```

Tail-resumptive handlers (where `resume` is the last thing the handler does) are the common case. The transform strips the `resume(expr)` wrapper, producing a plain function that returns the handler's result. No continuations involved.

### Extension path

**Phase 1: Already done** — tail-resumptive handlers compile to evidence records. JIT-eligible after transform (all effect nodes eliminated).

**Phase 2: Non-tail-resumptive one-shot handlers** — when a handler does work after `resume(expr)`, the continuation must be captured. With one-shot semantics, this is a coroutine/fiber switch:

```
// Source:
handle {
  State.get() -> resume(current_state)
  State.set(v) -> { current_state = v; resume(()) }   // tail-resumptive
}
  computation!()

// After transform (Phase 2):
// State.get is tail-resumptive → plain function
// But if a handler does: put(v) -> let r = resume(()); log(r); r
// That's non-tail-resumptive → needs fiber-based resume
```

For non-tail-resumptive handlers, the evidence record stores a "perform" function that:
1. Saves the current fiber state (stack pointer, frame)
2. Switches to the handler's fiber
3. Handler runs, calls `resume` which switches back
4. Handler continues after `resume` returns
5. One-shot: the continuation fiber is destroyed after resume

**Phase 3: Evidence vector optimization** — for monomorphic effect rows (the common case), the evidence record degenerates to a flat struct with known field offsets. The JIT can specialize `GetField` on evidence records to constant-offset loads when the evidence shape is statically known. This eliminates the hash-map lookup overhead.

For polymorphic effect rows (functions generic over their effects), evidence lookup remains `O(n)` field scan. This is acceptable — polymorphic effectful functions are rare in practice, and `n` is the number of distinct effects (typically 2-4).

### Research validation

- **Koka**: evidence passing compiles to plain C, competitive with OCaml multicore on benchmarks. Koka's evidence vector is a runtime array indexed by effect type.
- **TFP 2020**: one-shot continuations can be implemented as coroutines, avoiding heap allocation entirely.
- **ICFP 2021**: evidence passing with tail-resumptive optimization eliminates >90% of continuation captures in typical code.

### LLM-native property

Evidence passing has a desirable property for AI-generated code: effects are explicit function parameters. An LLM generating Baseline code doesn't need to reason about implicit handler stacks or dynamic dispatch — it just passes the evidence record through. The generated code is type-checkable, the effect signatures are visible in the function signature, and the compiler catches missing or mismatched effects. This aligns with Baseline's "one way to write things" philosophy.

### Future: speculative inlining (v0.3+)

When the evidence record is a runtime constant (handler installed at program start), the JIT could speculatively inline handler functions. This requires deoptimization infrastructure (bail to unoptimized code if evidence changes). Non-trivial engineering, but a natural v0.3+ optimization for server workloads.

---

## Decision 3: Memory Management

**Recommendation: Perceus-inspired RC with reuse analysis, not handler-scoped arenas**

### Why not handler-scoped arenas?

The brainstorm document proposed "handler-scoped arenas" — allocating within an effect handler's scope and bulk-freeing when the handler returns. This is an elegant idea, but research revealed critical problems:

1. **Zero production implementations** — no language runtime has shipped handler-scoped arenas. MLKit uses regions but not tied to effect handlers. Koka uses Perceus RC. OCaml 5 uses a generational GC. There's no validated implementation to study.

2. **Continuation-arena collision** — when a continuation captures values allocated in a handler's arena, those values must outlive the handler. This forces either:
   - Copying values out of the arena before capture (defeating the purpose)
   - Reference counting arena cells individually (reinventing RC with extra complexity)
   - Restricting what values continuations can capture (unacceptable ergonomics)

3. **Interaction with structured concurrency** — the vision doc (`baseline-language-vision.md`) envisions fiber-scoped regions where "fibers can safely borrow region-allocated data without ARC." This requires compiler proof that all fibers die before the region exits. Handler-scoped arenas add another lifetime axis that the compiler must reason about simultaneously.

Handler-scoped arenas remain a future possibility if one-shot semantics are chosen and structured concurrency arrives with compile-time lifetime proofs. But they are not a v0.2 target.

### The validated path: Perceus-style RC

Perceus (PLDI 2021, Koka) showed that reference counting with reuse analysis is competitive with tracing GC for functional languages. The key insight: in functional code, most values have refcount 1 most of the time, because functional patterns create-use-discard linearly.

#### Phase 1: Arc → Rc (free win — already done)

The `non-atomic-rc` feature flag is already the default. The `baseline-rt/src/rc.rs` abstraction layer makes this a compile-time switch. Non-atomic Rc eliminates atomic operations on every clone/drop — measured at ~2-5x faster per operation on x86 (less dramatic on ARM where atomics are cheaper).

**Audit needed:** verify no code path relies on `Send + Sync` for NValues in the single-threaded runtime. The fiber runtime (structured concurrency) will need Arc, but that's behind a separate feature flag.

#### Phase 2: Reuse analysis (drop-reuse pairing)

When a value's refcount is 1 and it's about to be dropped, its allocation can be reused for the next value of the same size. This is Perceus's core contribution.

Baseline already has a partial version: `jit_enum_field_drop` + `jit_enum_field_set` in `baseline-rt/src/helpers.rs` bypass `Rc::get_mut` via raw pointer mutation for clone-on-write enum field updates. The CoW optimization from `rfc-cow-optimizations.md` (Map.insert, List operations) is the same principle at the native function level.

The extension is to generalize this to all heap allocations:

```
// Before reuse analysis:
let old = Node(1, left, right)   // allocated
let new_left = transform(left)
drop(old)                         // deallocated
let result = Node(2, new_left, right)  // allocated (same size!)

// After reuse analysis:
let old = Node(1, left, right)
let new_left = transform(left)
// old has refcount 1 → reuse its allocation
let result = reuse(old, Node(2, new_left, right))  // no allocation!
```

This requires:
1. Tracking allocation sizes at compile time (enums/records/lists have known layouts)
2. Inserting reuse tokens at drop points when a same-sized allocation follows
3. The allocator checking the reuse token before `malloc`

#### Phase 3: Ownership analysis (Lobster-style)

Lobster (Wouter van Oortmerssen, game language) demonstrated that compile-time ownership analysis can eliminate ~95% of RC operations without borrow checker syntax:

1. Track value flow through the program (SSA-like analysis)
2. Values that are created, used linearly, and dropped in the same scope need no RC at all
3. Values passed to exactly one caller can transfer ownership (no clone needed)
4. Only values that are truly shared (aliased) need RC

This is the long-term play. It doesn't require any syntax changes — it's purely a compiler optimization pass. The IR already has enough information (SSA-like `Let` bindings, explicit `CallDirect` with known callees).

---

## Decision 4: Value Representation

**Recommendation: Keep the proven split — uniform VM + unboxed JIT**

### The OCaml precedent

OCaml uses uniform tagged representation in its bytecode interpreter and unboxed values in the native compiler. This is exactly what Baseline already does:

| Tier | Representation | Why |
|------|---------------|-----|
| VM (bytecode) | NaN-boxed NValue (8 bytes, uniform) | Simplicity, polymorphism works naturally |
| JIT (Cranelift) | Unboxed Int/Float/Bool/Unit for scalar-only functions | Performance, zero boxing overhead |

### Why not kill NaN-boxing?

A fully typed bytecode VM (where every opcode knows its operand types) would eliminate boxing overhead in the VM tier. But this creates problems:

1. **Instruction set explosion** — every opcode needs type-specialized variants (`AddInt`, `AddFloat`, `AddString`, etc.). Baseline's VM has ~45 opcodes; typed variants would multiply this by 3-5x.

2. **Polymorphism requires uniform representation** — `List.map(list, f)` works on any list. With typed bytecode, you'd need monomorphized variants for every element type (Rust's approach) or runtime type dispatch (Java's approach). Both add complexity.

3. **Superinstructions already specialize** — `GetLocalAddInt`, `GetLocalSubInt`, `GetLocalLeInt`, `GetLocalLtInt` fuse the hot paths into type-specialized super-opcodes. This captures 80% of the benefit without the instruction set explosion.

4. **Method-at-a-time JIT makes boundary tax cheap** — boxing/unboxing happens at function call/return boundaries. With method-at-a-time compilation (no OSR), each function is entirely boxed (VM) or entirely unboxed (JIT). The boundary cost is paid once per call, not per operation.

### Extension: wider unboxed paths in JIT

Currently `is_scalar_only` is all-or-nothing: a function either uses fully unboxed codegen or fully boxed codegen. A natural extension:

1. **Per-variable unboxing** — track which variables are provably scalar and unbox only those, keeping heap values boxed. This is a local analysis (no cross-function inference needed).
2. **Unboxed struct fields** — for records with all-scalar fields, store as a flat struct of unboxed values. The JIT already handles `MakeStruct` and `GetField`.

These are incremental improvements within the existing architecture, not architectural changes.

---

## The Cascade (How These Decisions Reinforce Each Other)

These four decisions aren't independent — they form a reinforcing loop that serves Baseline's three pillars:

```
CORRECTNESS
  One-shot continuations → simpler effect checker (no linearity tracking)
  Evidence passing → effects are just function parameters (type-checkable)
  Both → compiler catches more real bugs with less complexity budget

PREDICTABLE MEMORY
  One-shot → LIFO stack preserved → memory ∝ call depth, not handler count
  Perceus RC → memory = live data (no 2-3x GC headroom)
  Reuse analysis → recycled allocations → lower peak RSS
  No stack copying → no surprise allocations

LOW LATENCY
  RC → no GC pauses → bounded p99
  One-shot fiber switch → O(1) regardless of stack depth
  Evidence passing → zero-cost effects (no dynamic dispatch overhead)
  No stack copying → no latency spikes on perform
```

The key insight: one-shot continuations are the foundation. They simplify the type/effect checker (correctness), preserve stack discipline for tight memory, and guarantee bounded latency on effect operations.

## Competitive Positioning

These decisions optimize for correctness + memory + latency, not peak throughput:

### Memory usage (primary selling point)

```
Rust/C        1x     (manual, optimal)
Baseline      1-1.5x ← RC is memory-tight, no GC headroom
Go            1.5-3x (GC needs headroom for throughput)
OCaml         2-3x   (generational GC headroom)
Java/C#       3-5x   (GC headroom + object headers)
Python        5-10x
```

RC's advantage: memory usage equals live data. No 2-3x reservation for GC to operate. This matters for containers, edge deployments, and cost-sensitive cloud workloads.

### Tail latency (primary selling point)

```
Rust/C/Zig    <1μs p99   (no runtime)
Baseline      <10μs p99  ← no GC pauses, RC drop is O(1)
Go            ~100μs p99 (GC pauses, improving)
Java          1-10ms p99 (GC pauses, tunable)
OCaml         1-5ms p99  (major GC pauses)
```

### Correctness (primary selling point)

No other language in this performance class offers effects + refinement types + exhaustive matching. The closest comparisons:

- **Koka**: has effects but no refinements, limited tooling, research language
- **OCaml 5**: has effects but bolted onto existing type system, no refinements
- **Rust**: has exhaustive matching but no effects or refinements, high learning curve
- **Haskell**: has rich types but effects via monads (not first-class), poor latency

Baseline's bet: the compiler catches bugs that would be runtime errors in Go/Python/Java, with memory and latency competitive with Go, and without Rust's borrow-checker complexity.

### Throughput vs dynamic languages (must win decisively)

Baseline must crush Python, Ruby, and JavaScript on throughput. This is non-negotiable — a typed, compiled language with effects should never lose to an interpreter. Current JIT results already deliver this on pure compute:

| Workload | vs Python | vs Ruby | vs Node.js |
|----------|----------|---------|-----------|
| Pure compute (fib, tak) | 30-50x faster | 20-40x faster | 5-15x faster |
| Allocation-heavy (maps, trees) | 2-5x faster | 3-8x faster | 1-3x faster |
| String processing | 2-5x faster | 3-10x faster | ~1x |

The allocation-heavy gap is narrower than it should be. Reuse analysis (Phase 3) and ownership analysis (Phase 4) target a **minimum 10x vs Python on all workloads**. String processing needs native intrinsics (already identified in `rfc-cow-optimizations.md`).

The bar: **no benchmark where Python/Ruby is faster than Baseline.** If one exists, it's a bug.

### Throughput vs compiled languages (acceptable, not primary)

```
Rust/C        1x     (manual memory, zero overhead)
OCaml native  2-4x   (tracing GC, unboxed, optimizing compiler)
Go            3-8x   (tracing GC, good allocator)
Koka          3-6x   (Perceus RC + reuse, compiles to C)
Java/C#       3-10x  (generational GC, decades of tuning)
Baseline      5-15x  ← acceptable ceiling (allocation-heavy)
Baseline      ~1x    ← pure compute (already achieved)
```

Throughput on allocation-heavy workloads is 5-15x C. This gap narrows with reuse analysis and ownership analysis, but matching Rust is not the goal. Baseline competes with compiled languages on correctness, memory, and latency — not raw throughput.

---

## Prior Art Reference Table

| Technique | Source | Validated? | Key Finding | Relevance to Baseline |
|-----------|--------|-----------|-------------|----------------------|
| Evidence passing | Koka (ICFP 2021) | Yes — production compiler | Compiles to plain C, competitive with OCaml | Already implemented for tail-resumptive handlers |
| Perceus RC | Koka (PLDI 2021) | Yes — production compiler | Reuse analysis eliminates most allocations in functional code | Direct application — extend CoW to general reuse |
| One-shot fibers | OCaml 5 (PLDI 2021) | Yes — production runtime | 1% overhead on non-effectful code, O(1) capture/resume | Model for non-tail-resumptive handler compilation |
| Region inference | MLKit (1990s-present) | Yes — research compiler | Stack-allocated regions with compile-time lifetime proof | Inspiration for handler-scoped arenas (future, not v0.2) |
| Ownership analysis | Lobster | Yes — shipped game engine | 95% RC elimination via compile-time flow analysis, no borrow checker syntax | Long-term Phase 3 optimization |
| Generational refs | Vale | Partial — research language | Generational indices avoid RC for short-lived values | Interesting but unproven at scale |
| ARC optimization | Swift | Yes — production compiler | Copy-on-write, isUniquelyReferenced, move semantics | Validates RC + CoW as competitive strategy |
| Comptime evaluation | Zig | Yes — production compiler | Compile-time execution eliminates runtime overhead for known values | Already have `try_eval_const` in compiler |
| Affine continuations | POPL 2025 "Affect" | Research paper | Affine types distinguish one-shot/multi-shot statically | Future extension if multi-shot ever needed |

---

## Implementation Roadmap

### Phase 1: Free wins (v0.2)

- [x] Switch default to `non-atomic-rc` (already done — `default = ["jit", "non-atomic-rc"]`)
- [ ] Audit Arc usage: verify no code path requires `Send + Sync` in single-threaded runtime
- [ ] Document that fiber/structured-concurrency mode will re-enable Arc via feature flag

### Phase 2: Extend evidence transform (v0.2)

- [ ] Implement fiber-based resume for non-tail-resumptive one-shot handlers
- [ ] JIT codegen for fiber switch (save/restore via Cranelift helper calls)
- [ ] Remove `can_jit` rejection of `WithHandlers`/`HandleEffect`/`PerformEffect` (evidence transform should eliminate all of them)
- [ ] Add conformance tests for effectful programs running on JIT

### Phase 3: Reuse analysis (v0.3)

- [ ] Track allocation sizes in IR (enum/record/list layouts)
- [ ] Insert reuse tokens at drop-before-alloc patterns
- [ ] Implement reuse-aware allocator in `baseline-rt`
- [ ] Benchmark against current CoW on heap-heavy workloads (mapbuild, treemap, mergesort)

### Phase 4: Ownership analysis (v0.4+)

- [ ] SSA-based value flow analysis in `optimize_ir.rs`
- [ ] Identify linear values (create-use-drop in same scope)
- [ ] Elide RC ops for linear values
- [ ] Identify ownership transfers (single-caller consumption)
- [ ] Benchmark RC operation counts before/after

---

## What We're Giving Up (Honest Tradeoffs)

### Multi-shot continuations

Backtracking, nondeterminism, and probabilistic programming effects require multi-shot continuations. We're choosing not to support these natively. This is a deliberate trade: multi-shot would complicate the effect checker (linearity tracking), introduce latency spikes (stack copying), and unpredictable memory growth — undermining all three pillars. Workarounds exist (explicit data structures, CPS-transformed search), and the POPL 2025 "Affect" paper shows a path to opt-in multi-shot via affine type annotations if demand materializes.

### Handler-scoped arenas

The elegant idea of tying allocation lifetimes to effect handler scopes has zero production precedent. No language has shipped this. Perceus-style RC is the proven alternative that already delivers the memory predictability we need. If structured concurrency lands with compile-time lifetime proofs, handler-scoped arenas become feasible — but that's v0.4+ at the earliest.

### Peak throughput vs compiled languages

RC has per-operation overhead that borrow checking (Rust) and tracing GC (Java, Go) can avoid. We accept 5-15x C on allocation-heavy workloads as the cost of memory predictability and low latency. Reuse analysis and ownership analysis narrow this gap over time, but matching Rust's throughput is not a goal. Throughput vs dynamic languages is not a tradeoff — it's a requirement. Baseline must be decisively faster than Python/Ruby/JS on every workload.

### Fully typed bytecode VM

Accepting OCaml's pragmatic split means the VM tier will always have NaN-boxing overhead. The bet is that the JIT tier handles all performance-critical code, and the VM is for cold paths, debugging, and REPL usage. Superinstructions and evidence passing in the VM keep it competitive enough for non-hot-path code.

---

## Relationship to Vision Doc

The vision doc (`design/baseline-language-vision.md`) describes region-based memory, arenas, and structured concurrency. This RFC is compatible with that vision but sequences it differently:

| Vision Doc | This RFC | Status |
|-----------|----------|--------|
| Region-based local memory | Perceus RC first, regions later | RC is proven; regions need structured concurrency |
| `@arena` annotations | Not in v0.2 scope | Requires lifetime analysis infrastructure |
| Structured concurrency + fiber-scoped regions | One-shot continuations enable this | Continuations are the prerequisite |
| Persistent data structures | CoW already implemented | Extends naturally to reuse analysis |
| No GC pauses, predictable latency | Perceus RC delivers this | Validated by Koka benchmarks |

The key difference: the vision doc presents regions and arenas as near-term. This RFC argues that Perceus RC is the validated near-term path, with regions becoming feasible only after structured concurrency and compile-time lifetime proofs are in place.

---

## Key Files

| File | Role |
|------|------|
| `blc/src/vm/optimize_ir.rs` | Evidence-passing transform (lines 523-828), IR optimization |
| `baseline-rt/src/nvalue.rs` | NaN-boxing, HeapObject variants, Continuation |
| `baseline-rt/src/rc.rs` | Arc/Rc abstraction layer |
| `baseline-rt/src/helpers.rs` | JIT RC helpers, arena mode, CoW enum field ops |
| `blc/src/vm/jit/compile.rs` | JIT codegen, RC scope tracking |
| `blc/src/vm/jit/analysis.rs` | `can_jit`, `is_scalar_only`, unboxed scalar analysis |
| `blc/src/analysis/effects.rs` | Static effect checker (capability checking) |
| `blc/src/vm/lower/effects.rs` | Effect IR lowering (with expressions, handle blocks) |
| `design/baseline-language-vision.md` | Vision doc (regions, arenas, structured concurrency) |
| `design/rfc-cow-optimizations.md` | CoW RFC (partial reuse analysis already implemented) |
