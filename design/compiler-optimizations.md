# Compiler optimizations for functional data structures across Koka, Lean 4, OCaml, and Rust

**Reference counting with reuse analysis, as pioneered by Koka's Perceus and Lean 4's reset/reuse, enables purely functional code to execute with near-zero allocation overhead when data is uniquely owned — a result that fundamentally challenges the assumption that functional programming must sacrifice performance for immutability.** This survey examines five interconnected compiler optimizations across four languages and finds that the combination of precise reference counting, drop specialization, tail-recursion modulo context, and flat data representations can close the performance gap between functional and imperative code on tree-heavy workloads to within 10% of hand-optimized C++. The key architectural decision — tracing GC versus reference counting versus static ownership — cascades through every optimization in this stack, determining which transformations are possible and how they interact.

---

## 1. Perceus reuse analysis turns functional updates into in-place mutation

### The formal framework

Perceus ("Precise Reference Counting with Reuse and Specialization," Reinking, Xie, de Moura, Leijen, PLDI 2021 Distinguished Paper) formalizes reference counting insertion using a **linear resource calculus λ₁**. The core judgment `Δ | Γ ⊢ e ⇝ e'` translates expression `e` under a borrowed context Δ and owned context Γ into `e'` with explicit `dup` (increment RC) and `drop` (decrement RC, free if zero) operations inserted. The algorithm is syntax-directed: ownership transfers to callees, `dup` is inserted for multiple uses of a variable, and `drop` is inserted when a variable goes out of scope unconsumed.

The reuse analysis algorithm operates before dup/drop insertion. For each pattern match, it pairs deconstructed values with newly constructed values of the **same allocation size** in that branch. Instead of emitting `drop(xs)`, the compiler emits `val ru = drop-reuse(xs)`, which returns a **reuse token** — either a pointer to the freed memory cell (when uniquely owned) or NULL (when shared). The annotated constructor `Cons@ru(...)` then either writes fields into the reused memory or allocates fresh:

```
fun drop-reuse(x) {
  if (is-unique(x)) then { drop children of x; &x }   // return address
  else { decref(x); NULL }                              // can't reuse
}
```

The follow-up paper **FP²: Fully in-Place Functional Programming** (Lorenzen, Leijen, Swierstra, ICFP 2023) formalized **reuse credits**: when a destructive match deconstructs `Node(l, x, r)`, it yields the children plus a reuse credit `◇₃` of size 3 that has zero size in the store. The central theorem proves that **the size of the store does not change during any reduction** of FIP programs — they execute fully in-place with no (de)allocation. A further refinement, **drop-guided reuse** (Lorenzen & Leijen, ICFP 2022), replaced the original fragile reuse analysis with a simpler algorithm that follows drop structure, proving frame-limitedness: retained memory on each function call is bounded by a constant factor.

### Koka's implementation

Koka compiles to C11 without a garbage collector. Its pipeline runs evidence translation (compiling algebraic effect handlers into explicit control flow), then Perceus RC insertion, drop specialization, reuse analysis, reuse specialization, and TRMC before C code generation. The `fip` keyword statically verifies that a function executes with zero allocation and constant stack space; `fbip` allows deallocation but guarantees memory reuse for unique values.

A concrete transformation of `map` illustrates the full optimization chain. The source:

```koka
fun map(xs, f) = match xs
  Cons(x, xx) -> Cons(f(x), map(xx, f))
  Nil -> Nil
```

After Perceus with all optimizations applied:

```
fun map(xs, f) = match xs
  Cons(x, xx) ->
    val ru = if is-unique(xs) then &xs           // reuse: zero RC ops
             else { dup(x); dup(xx); decref(xs); NULL }
    Cons@ru(dup(f)(x), map(xx, f))
  Nil -> { drop(xs); drop(f); Nil }
```

On the fast path (unique `xs`), **no reference counting operations occur and no memory is allocated** — the list is updated entirely in-place. On the red-black tree insertion benchmark, Koka's purely functional implementation runs within **10% of C++ `std::map`**.

### Lean 4's reset/reuse

Lean 4's "Counting Immutable Beans" (Ullrich & de Moura, IFL 2019) introduced reset/reuse, the direct precursor to Perceus. The `reset x` instruction checks if `x` has RC = 1; if unique, it decrements children's reference counts and returns `x`'s memory for reuse. The `reuse y in ctor_i fields` instruction conditionally reuses that memory. The separation of reset and reuse is critical: if fused, recursive calls between them would see inflated reference counts and prevent reuse.

Lean's `ExpandResetReuse` pass then lowers these into concrete operations — `reuseToSet` replaces constructor allocation with in-place field mutations, and `releaseUnreadFields` handles untouched fields. Lean introduces **borrowed references** (parameters guaranteed alive by a surrounding owned reference) that eliminate RC operations entirely for read-only access. The paper observes the **"resurrection hypothesis"**: many objects die just before creating an object of the same kind — exactly the pattern functional updates produce.

| Feature | Koka (Perceus) | Lean 4 (CIB) |
|---------|---------------|---------------|
| Formalism | Linear resource calculus λ₁ | Big-step operational semantics for λ_RC |
| Reuse mechanism | `drop-reuse` → reuse token, `C@ru` constructors | `reset`/`reuse` instruction pair |
| Drop specialization | Explicit optimization pass with dup/drop fusion | Implicit in `ExpandResetReuse` |
| Reuse specialization | Skips unchanged field writes | `reuseToSet` with per-field mutations |
| Static FIP verification | `fip`/`fbip` keywords | Not available |
| Borrowing | Planned; `^` parameter annotation | Inferred borrowed references |

### Rust: static ownership without automatic reuse

Rust's ownership system provides **stronger static guarantees** but **no automatic reuse analysis**. When Rust pattern-matches and reconstructs a value, the compiler does not detect this as an in-place reuse opportunity — LLVM may optimize some cases, but it is not guaranteed. The programmer must explicitly use `&mut` references and write imperative mutations to achieve in-place updates. `Rc::make_mut()` provides the closest equivalent to Perceus's dynamic reuse: it clones only if shared and mutates in place if unique, but this is opt-in and manual.

The fundamental tradeoff: **Perceus trades compile-time complexity for runtime flexibility**. Rust resolves ownership statically, eliminating all runtime overhead but requiring imperative style for in-place updates. Perceus lets programmers write purely functional code that automatically becomes in-place when data is uniquely owned, falling back gracefully to copying when shared.

### OCaml: GC precludes reuse analysis

OCaml's tracing GC cannot perform Perceus-style reuse because there is no reference count to check uniqueness at runtime. Memory is reclaimed asynchronously during collection phases. However, the **"Oxidizing OCaml" paper** (Lorenzen, White, Dolan, Eisenberg, Lindley, OOPSLA 2024) introduces **modes** — locality, uniqueness, and affinity — that bring Rust-like static uniqueness checking to OCaml's type system. Unique values can be mutated in place even though nominally immutable, providing a static analog to Perceus's dynamic reuse. Jane Street is actively deploying locality modes in production OCaml.

---

## 2. Drop specialization eliminates reference counting on the fast path

Drop specialization is the optimization that makes Perceus practical. Instead of a generic recursive `drop(x)` that inspects tags at runtime, the compiler inlines the drop at each pattern match site where the constructor is already known. After matching `Cons(x, xx)`, the generic `drop(xs)` becomes:

```
if (is-unique(xs))
  then drop(x); drop(xx); free(xs)    // specialized: fields known
  else decref(xs)
```

The critical follow-up is **dup/drop fusion**: the `dup(x)` inserted for subsequent use and the `drop(x)` from specialization cancel out in the unique branch. The complete transformation chain for `map` progresses through four steps — dup/drop insertion → drop specialization → dup pushing → dup/drop cancellation — yielding a fast path where `is-unique(xs)` is true that contains **only a single `free(xs)` call with zero RC operations**.

When combined with reuse analysis, even the `free` disappears: the drop and allocation fuse into `drop-reuse`, and in the unique branch the address is simply returned for immediate reuse. **Reuse specialization** further optimizes by skipping unchanged field writes — in red-black tree rebalancing, if only the left child changes, only that field pointer is reassigned while all others remain untouched.

### Cross-language comparison

**Lean 4** achieves equivalent results through its `ExpandResetReuse` pass, which erases `inc` instructions on projected fields of the reset variable and converts `reuse` into in-place `set` operations. The `releaseUnreadFields` function handles fields not accessed before reset.

**Rust** generates **monomorphized drop glue** — per-concrete-type recursive drop code — through a MIR transformation pass called drop elaboration. This pass classifies each `Drop` terminator as static (always initialized, keep drop), dead (always uninitialized, remove), conditional (add drop flag), or open (recursively decompose into per-field drops). For enums, the elaborator checks the discriminant to select the active variant's drop path. Unlike Koka's per-site specialization that enables dup/drop fusion, Rust's drop glue is shared across all drop sites for a given type and does not fuse with allocation.

**OCaml** generates no drop code whatsoever. The tracing GC handles deallocation in batch during collection phases. `Gc.finalise` provides non-deterministic finalization for special cleanup, and custom blocks with C `finalize` callbacks handle external resources. The tradeoff is clear: OCaml avoids all per-mutation RC overhead but cannot exploit the unique-fast-path elimination that makes Perceus competitive with imperative code.

---

## 3. Tail-mod-cons transforms recursive builders into in-place loops

### The transformation

A function call is in **tail-modulo-cons (TMC) position** when the only remaining work after the call is constructor application. The TMC transformation, formalized by Bour, Clément, and Scherer (2021), converts such calls into **destination-passing style (DPS)**: allocate a partial constructor with a "hole" (uninitialized field), pass the hole's address as an extra parameter, and write the recursive result directly into the hole — making the recursive call a tail call. The compiler generates two variants: a direct variant (called externally, makes one non-tail call) and a DPS variant (purely tail-recursive, writes results into destinations).

For `List.map`:

```
(* DPS variant — tail-recursive *)
map_dps dst idx f = function
  | [] -> set_field dst idx []           (* fill final hole *)
  | x :: xs ->
    let y = f x in
    let block = alloc_cons y Hole in     (* partial cell *)
    set_field dst idx block;             (* link to previous *)
    map_dps block 1 f xs                 (* tail call *)
```

This achieves **O(1) stack usage** instead of O(n), while matching the performance of the non-tail-recursive version (unlike accumulator-with-reverse approaches, which are ~35% slower on small lists).

### OCaml's implementation (since 4.14)

OCaml's TMC is opt-in via `[@tail_mod_cons]` annotation, implemented in `lambda/tmc.ml` on the Lambda IR. Restrictions include: only one recursive call per constructor may be in TMC position (disambiguated with `[@tailcall]`); the transformation is first-order and intra-module only. A formal correctness proof was published at POPL 2025 using Coq and the Iris separation logic framework. The transformation temporarily violates immutability by creating and mutating partially-initialized blocks, operating below the type checker where this is invisible.

### Koka's generalized TRMC (POPL 2023)

Koka implements **Tail Recursion Modulo Context** — a strictly more general framework described by Leijen and Lorenzen (POPL 2023). Rather than being limited to constructor contexts, TRMC supports evaluation contexts (CPS), associative operations, monoids, semirings, and constructor contexts as instantiations of a single equational framework. Koka exposes TMC contexts as **first-class values**:

```koka
val c1 = ctx Cons(1, Cons(2, _))   // context with hole at _
val c2 = ctx Cons(3, _)
val c3 = c1 ++ c2                   // O(1) composition
val result = c3 ++. Nil             // application: [1,2,3]
```

The interaction with Perceus is synergistic: context nodes are always unique at runtime (verified by RC checks), so context composition and application are O(1) in-place mutations. When the input list is also unique, **zero allocation occurs** for the entire operation. Koka handles non-linear control (algebraic effect handlers that duplicate continuations) via a hybrid approach: runtime uniqueness checks detect when a context is no longer unique and fall back to copying.

### Lean 4 and Rust

**Lean 4 does not implement TMC.** Instead, it uses `@[csimp]` replacement lemmas: the specification of `List.map` is written naturally (non-tail-recursive) for theorem proving, while a separate tail-recursive implementation using accumulators is provided with a proven equivalence lemma. This trades TMC's elegance for proof-friendliness. Only direct self-recursion is eliminated as tail calls; mutual recursion and constructor-position calls are not optimized.

**Rust lacks TMC** and doesn't even guarantee basic tail-call optimization. LLVM's `musttail` has platform restrictions, Rust's destructors (Drop/RAII) break tail position, and the language culturally favors iterators over recursion. An experimental `become` keyword exists on nightly (`#![feature(explicit_tail_calls)]`) for explicit tail calls, but TMC has never been proposed. Workaround patterns include iterators, manual loops, and trampoline crates.

---

## 4. Region allocation excels for phase-structured workloads but neither Koka nor Lean uses it

### Foundational theory

Region inference, introduced by Tofte and Talpin (POPL 1994), extends the lambda calculus with `letregion ρ in e end` — creating a region, evaluating `e` (with all allocations placed into regions via `e at ρ`), then deallocating the region. The formal type system adds region-annotated types, effect annotations on arrow types, and region polymorphism. Regions form a stack discipline: if r₂ is created after r₁, r₂ must be deallocated first.

MLKit's implementation showed results "between 10 times faster and four times slower" than GC, depending on how region-friendly the program was. Key limitations include **region size explosion** (when a function returning results in one region forces that region's lifetime to extend far beyond what's needed) and the stack discipline restriction. MLKit later integrated region inference with generational GC for robustness (Hallenberg, Elsman, Tofte, PLDI 2002).

**Cyclone** (Grossman, Morrisett, Jim, Hicks, ~2001–2006) extended C with safe regions, introducing multiple region types (stack, heap, unique, reference-counted, dynamic), region annotations on pointers, and region polymorphism. Cyclone's innovations directly influenced Rust: polymorphic region variables `'r` became Rust's lifetime annotations `'a`, region subtyping became lifetime subtyping, and the combination of regions with linearity became ownership plus lifetimes.

### Rust's lifetimes are static regions

Rust's reference lifetimes are directly analogous to regions. A lifetime `'a` corresponds to a region — a scope during which references are valid. Lifetime parameters correspond to region polymorphism, and lifetime subtyping (`'a: 'b`) corresponds to region outlives relationships. The borrow checker enforces region discipline through flow-sensitive analysis with non-lexical lifetimes (NLL). Arena allocation libraries like **bumpalo** (heterogeneous bump allocation, O(1), no Drop by default) and **typed-arena** (single-type, runs Drop, supports cycles) leverage lifetimes to enforce that allocated objects cannot outlive the arena.

### Neither Koka nor Lean uses regions or bump allocation

Both Koka and Lean 4 chose **reference counting with mimalloc** (a high-performance free-list allocator) over regions or bump allocation. The rationale is fundamental: bump allocation requires either GC or bulk deallocation for reclamation, but RC needs individual object deallocation — the two are incompatible. mimalloc uses page-local sharded free lists that achieve competitive performance (7% faster than tcmalloc, 14% faster than jemalloc on Redis benchmarks) while supporting the individual frees that RC requires.

**OCaml's minor heap is effectively a bump allocator** — allocation costs approximately three inlined instructions (bump pointer, bounds check). The minor heap exploits the generational hypothesis perfectly: most functional values die young, and the copying collector's cost is proportional only to survivors (~10% survival rate). This partially compensates for the lack of reuse analysis — short-lived functional updates are very cheap.

### The formal tradeoff landscape

Bacon, Cheng, and Rajan's landmark paper **"A Unified Theory of Garbage Collection"** (OOPSLA 2004) proved that tracing and reference counting are **duals**: tracing operates on live objects ("matter") from roots, while RC operates on dead objects ("anti-matter") from anti-roots. All high-performance collectors are hybrids — generational GC traces the nursery while effectively reference-counting the boundary to mature space.

| Dimension | Tracing GC (OCaml) | RC (Koka/Lean) | Regions (MLKit/Rust arenas) |
|-----------|--------------------|-----------------|-----------------------------|
| Allocation cost | ~3 instructions (bump) | mimalloc free-list (~10–20 instructions) | ~3 instructions (bump) |
| Reclamation | Batch (GC pauses) | Immediate (deterministic) | Bulk (region deallocation) |
| Reuse analysis | Not possible without type extensions | Natural (check RC = 1) | Not applicable (bulk free) |
| Cycles | Handled automatically | Problematic | Prevented by stack discipline |
| Peak memory | ~2× live data | ~1× with full reuse | Region-dependent |
| Best for | Short-lived allocation-heavy code | Long-lived structures with functional updates | Phase-structured workloads |

---

## 5. Flat enum representations give Rust a decisive cache advantage

### Rust's niche optimization

Rust represents enums as **flat tagged unions** with aggressive niche optimization. When a variant's payload contains invalid bit patterns, those patterns encode data-less variants, **eliminating the discriminant entirely**. `Option<&T>` is the canonical example: it occupies exactly 8 bytes (one pointer), with `None` represented as null. This chains: `Option<Option<bool>>` occupies 1 byte. The compiler discovers niches for references (null), `NonZero*` types (zero), `bool` (values 2–255), and `char` (values above U+10FFFF). Nested enum optimization can encode outer variants using unused inner discriminant values.

### OCaml's boxing overhead

OCaml's uniform representation requires every non-immediate value to be a heap-allocated block with a header word. A `Some 42` allocates a 2-word block. Floats cost 24 bytes (pointer + header + 8 bytes data) versus 8 unboxed. `int32` and `int64` are boxed with 2–3 words overhead. No niche optimization exists. Jane Street's **unboxed types proposal** introduces a layout/kind system with `bits64` and `float64` layouts that break the uniform representation requirement, allowing raw 64-bit values to be passed in registers without allocation. This work remains in progress on internal branches.

### Lean 4 and Koka: partial unboxing with RC headers

**Lean 4** represents fieldless enums (all constructors parameterless) as unsigned integers without heap allocation. Single-constructor single-field types are erased entirely. All other inductives are heap-allocated `lean_object*` with an RC header, tag, boxed pointer fields, then scalar fields ordered by decreasing size. Small natural numbers are encoded as tagged pointers (shifted left + 1, like OCaml's immediates). Scalar fields within constructors are stored unboxed in the object's scalar section.

**Koka** uses a similar tagged-pointer scheme: small integers and enum-like constructors are immediate values, while multi-field constructors are heap-allocated blocks with RC, tag, and scan count headers. The `value` type modifier enables inline/unboxed storage — a `value struct` with one constructor avoids heap allocation entirely. This interacts with Perceus: reuse analysis depends on constructors having the **same scan count and size**, so uniform boxed representation simplifies reuse pairing. Rust-style niche optimization would complicate reuse because variants with different sizes cannot be straightforwardly swapped.

### Cache impact on tree workloads

The performance implications are substantial. L1 cache hits cost ~1ns while main memory accesses cost ~60ns — a **60× penalty** for pointer chasing. Each level of boxing adds an indirection. An OCaml `float option` traverses: pointer → block header → pointer → float block → data. A Rust `Option<f64>` reads 16 contiguous bytes. For tree-heavy workloads where every node access is a potential cache miss, Rust's flat layout provides a structural advantage that no amount of algorithmic optimization can fully compensate for. The Counting Immutable Beans benchmarks confirm this: Lean 4 (with its partial unboxing of scalars within objects) runs **4× faster** than OCaml on `const_fold`, spending 13% on deallocation versus OCaml's 91% on GC.

---

## 6. How these optimizations interact and combine

### The reuse-TMC synergy

The most powerful interaction is between **reuse analysis and TRMC** in Koka. TRMC transforms recursive constructors into loops with destination passing, while Perceus ensures the destination nodes are reused in-place when uniquely owned. For `map` over a unique list, the combination yields: (1) TRMC converts the recursive build into a loop, (2) each `Cons` cell is reused from the input list via Perceus, (3) the function writes new values into existing memory with no allocation and O(1) stack. Neither optimization alone achieves this — TRMC without reuse still allocates fresh nodes, and reuse without TRMC still uses O(n) stack.

### Representation constrains reuse

Flat enum layouts (Rust-style) and reuse analysis exist in tension. Perceus pairs matched and constructed values by allocation size — all `Cons` cells are the same size, so any destructed `Cons` can be reused for any new `Cons`. Niche optimization creates variants of different sizes, breaking this invariant. This is one reason Koka and Lean maintain uniform boxed representations: it maximizes reuse opportunities at the cost of cache density.

### Drop specialization enables everything else

Without drop specialization, dup/drop fusion cannot occur, and the fast path (unique references) carries full RC overhead. Drop specialization is the foundation that makes reuse analysis practical: by inlining the drop at the match site where the constructor is known, it creates the dup/drop pairs that cancel, enabling the zero-RC-operation fast path. Lean 4's `ExpandResetReuse` achieves the equivalent by erasing `inc` instructions on projected fields of the reset variable.

### The best combination for tree-heavy workloads

For insert, map, fold, and sum over trees, the benchmarks strongly favor **Koka's full optimization stack**: Perceus reuse + drop specialization + TRMC + reuse specialization. On red-black tree insertion (4.2M elements), purely functional Koka runs within ~10% of C++ `std::map`. The key: every `Node` destruction is paired with a `Node` construction via reuse analysis, unchanged fields are skipped via reuse specialization, and TRMC ensures constant stack depth. Lean 4 achieves similar results via reset/reuse. OCaml's fast minor-heap bump allocation provides competitive throughput for small ephemeral trees but falls behind on large persistent structures where GC dominates (91% of time on `const_fold`). Rust achieves the best raw performance when programmers write imperative-style mutations, but functional-style Rust code does not benefit from automatic reuse.

---

## Conclusion

The five optimizations surveyed form an interconnected system where each technique amplifies the others. Three key insights emerge that were not obvious at the outset.

First, **the choice of memory management strategy is the single most consequential architectural decision**, determining which optimizations become possible. Reference counting enables reuse analysis (check RC = 1) and deterministic drop specialization. Tracing GC enables bump allocation but precludes reuse analysis without type-system extensions like OCaml's emerging modal memory management. Static ownership (Rust) eliminates runtime overhead entirely but forces imperative style for in-place updates.

Second, **Koka's TRMC generalization to arbitrary contexts (POPL 2023) represents a genuine theoretical advance** over OCaml's constructor-only TMC. By treating constructor contexts, CPS, and associative operations as instantiations of a single equational framework, Koka achieves broader optimization coverage from a simpler formal foundation. The interaction with Perceus — where context uniqueness is verified by RC at runtime — solves the problem of non-linear control flow that neither OCaml's TMC nor traditional DPS approaches handle.

Third, **the tension between flat representations and reuse analysis suggests a frontier for future research**. Rust's niche optimization and flat enums provide superior cache performance, while Koka and Lean's uniform boxed representations enable broader reuse. A system that could perform niche-aware reuse analysis — pairing variants of different sizes when the new variant fits within the old allocation — would combine the cache benefits of flat layouts with the allocation elimination of Perceus. This remains an open problem with significant practical implications for functional language performance.
