# Designing a fast functional language for Cranelift JIT

**A functional language can match C within ~1.5× on N-body simulations through Cranelift JIT — but only if seven design decisions are made correctly at the language level.** The performance gap between functional and imperative languages on this benchmark stems not from inherent limitations of functional programming but from specific representational choices: boxed numerics, heap-allocated closures, inability to express in-place mutation, and data layouts hostile to SIMD. Each of these problems has a known solution in the programming language design literature, and several have been validated in production systems. The challenge is combining them coherently in a single language while preserving the ergonomic and correctness properties that make functional languages valuable.

The N-body benchmark is a nearly ideal stress test for these decisions. Its 280-byte working set fits entirely in L1 cache, making it purely compute-bound. Its 50 million iterations of 10 pairwise force calculations amplify any per-operation overhead billions of times. And its requirement for mutable state — updating 30 floating-point values in place each step — directly challenges functional purity. What follows are the concrete design choices needed, grounded in analysis of top benchmark implementations, Cranelift's capabilities and limitations, and the best ideas from MLton, Futhark, Koka, Roc, and OxCaml.

## The N-body inner loop defines the performance ceiling

The benchmark simulates five Jovian planets using a symplectic integrator. The `advance()` function, called 50 million times, computes pairwise position deltas for all **10 body pairs**, derives gravitational forces via reciprocal square root, updates velocities, then updates positions. At the machine code level, the fastest implementations (C with SSE2 intrinsics, safe Rust via LLVM auto-vectorization) share these properties: **branch-free fully-unrolled loops**, SIMD processing of two pairs simultaneously via `F64X2` packed operations, reciprocal-sqrt approximation with Newton-Raphson refinement replacing expensive `sqrt`/`div`, and a hybrid data layout where bodies use array-of-structs but intermediate pairwise deltas use struct-of-arrays for contiguous SIMD loads.

A remarkable result from the "DangeRust" series demonstrated that safe, idiomatic Rust with no SIMD intrinsics can *beat* hand-optimized C SSE code, because Rust's `&mut` aliasing guarantees give LLVM strictly more optimization freedom than C's `restrict` keyword. This is a critical insight for functional language design: **purity provides stronger no-aliasing guarantees than any imperative language can express**, which should translate to equal or better auto-vectorization potential — if the language gets representation right.

The performance tiers for this benchmark are well-established. Tier 1 (1.0–1.2×) includes C/C++/Rust with SIMD intrinsics. Tier 2 (1.2–1.5×) includes Rust/Zig/Fortran with auto-vectorization. Tier 3 (1.5–2.5×) includes OCaml, Go, and plain C without SIMD. Tier 4 (2.5–4×) includes optimized Haskell, Java, and JavaScript JITs. Functional languages today sit in tier 3–4. The goal is tier 2.

## Cranelift demands that the frontend do the heavy optimization work

Cranelift's architecture fundamentally shapes what the language compiler must handle itself. The code generator provides excellent foundations — **unboxed F64 values live naturally in XMM registers**, first-class `F64X2` SIMD types enable 128-bit vectorization, `fma` (fused multiply-add) instructions are directly expressible, and the `regalloc2` register allocator handles high FP register pressure well through live-range splitting. Stack slots with custom alignment support local array allocation, and the `Fast` calling convention lets Cranelift optimize internal parameter passing.

However, Cranelift deliberately omits optimizations that LLVM provides. **There is no auto-vectorization** — the frontend must explicitly emit SIMD operations. **There is no loop unrolling** — the frontend must generate unrolled loop bodies. There is no advanced alias analysis, no induction variable optimization, no loop interchange or tiling. The e-graph-based mid-end handles LICM (via scoped elaboration), GVN, constant folding, and algebraic simplification, but this is a narrower optimization surface than LLVM's 96+ passes. The measured performance gap is approximately **14% slower than LLVM** on general workloads, potentially larger for tight FP loops due to the missing loop optimizations.

Practical SIMD is limited to **128-bit vectors** (matching WebAssembly SIMD). While the type system supports wider types like `F64X4`, backend support for 256-bit AVX operations is not production-ready. Inlining support landed in Wasmtime v36 (2025) but remains off-by-default and immature. Tail calls are fully supported via `CallConv::Tail` with explicit `return_call` instructions.

The implication is clear: a language targeting Cranelift must implement its own frontend passes for vectorization, unrolling, and data layout transformation. This is actually an advantage for a domain-aware compiler — the frontend understands types and data layouts far better than a general-purpose backend could, and can make decisions (like SoA transformation) that no backend optimizer would attempt.

## Seven non-negotiable language design decisions

### 1. Unboxed numerics as the default representation

The single highest-impact decision is ensuring that `Float64` is a raw 64-bit IEEE double, not a pointer to a heap-allocated box. GHC's levity polymorphism paper measured a **200× slowdown** from boxing in tight integer loops — ten million iterations taking 2 seconds boxed versus 0.01 seconds unboxed. For N-body's 50 million iterations of ~150 FP operations each, boxing any intermediate value destroys performance irreversibly.

The language's kind system should distinguish representations at the type level, similar to GHC's `RuntimeRep` but with unboxed as the default for numeric types. Every `Float64`, `Int64`, and `Bool` should compile to a machine register value with zero indirection. Compound types like `Body = { x: Float64, y: Float64, z: Float64, vx: Float64, vy: Float64, vz: Float64, mass: Float64 }` should lay out as 7 contiguous doubles (56 bytes) with no headers, tags, or pointers.

Unboxed tuples should be supported for multi-value returns — a function returning `(Float64, Float64, Float64)` should return values in three XMM registers via Cranelift's `Fast` calling convention, not allocate a tuple on the heap. This maps directly to Cranelift's ability to return multiple SSA values from a function.

### 2. Full monomorphization eliminates polymorphism overhead at JIT time

Polymorphism is the enemy of unboxing. A function `map : (a → b) → Array a → Array b` cannot be compiled to tight machine code without knowing whether `a` and `b` are 8-byte doubles, 1-byte booleans, or heap-allocated records. MLton demonstrated that whole-program monomorphization — specializing every polymorphic function to its concrete type arguments — enables "untagged and unboxed native integers, reals, and words, unboxed native arrays" with no overhead from the type system's generality.

A JIT compiler has an even stronger advantage here: it observes actual call sites with concrete types and can specialize on demand, avoiding the code-size explosion that AOT monomorphization risks. Roc made the deliberate choice to restrict its type system to Rank-1 types specifically to guarantee that all code can be fully monomorphized, accepting the expressiveness limitation in exchange for zero runtime polymorphism cost. This is the right tradeoff for a performance-oriented language.

The language should also implement **defunctionalization** for closures, following Roc's lambda-set specialization approach. Instead of representing closures as heap-allocated function-pointer-plus-environment pairs, the compiler converts each closure to a tagged union of its possible captured environments with static dispatch. This eliminates vtable overhead, enables inlining, and removes closure allocation from hot paths entirely.

### 3. Affine types enable in-place mutation with zero runtime cost

The core tension in functional N-body code is that the algorithm mutates 30 floating-point values in place each timestep. A naive pure implementation allocates 280 bytes × 50M = 14GB of theoretical garbage. Even with a generational GC handling this efficiently, the allocation overhead dwarfs the actual computation.

**Affine types** (values used at most once) solve this at compile time with zero runtime overhead. The mechanism, validated by Futhark's uniqueness types and Clean's `*Array`, is straightforward: if the type system proves that an array handle has no other references, updating it in place is observationally equivalent to creating a new copy. The compiler emits a direct `store` instruction instead of allocate-copy-modify.

The minimal API for mutable arrays via affine types:

- `Array.new : Int → a → Array a` (creates with affine ownership)
- `Array.set : Array a → Int → a → Array a` (consumes old, returns updated — same pointer)
- `Array.get : &Array a → Int → a` (borrows, doesn't consume)
- `Array.freeze : Array a → ImmArray a` (consumes mutable, returns immutable shared reference)

The `set` operation takes and returns the array linearly, threading ownership. In the compiled output, this becomes a single `stack_store` to the array's memory with no allocation. Futhark proves this works at scale — its `A with [i] = v` syntax compiles to destructive in-place writes when the type system confirms uniqueness, achieving GPU-competitive performance from purely functional source code.

The ergonomic concern with linear types — that they "infect" surrounding code — can be mitigated through syntactic sugar that auto-threads array tokens through sequential operations, similar to Haskell's `do`-notation for monads but for ownership threading.

### 4. An effect system makes local mutation invisible outside hot loops

Beyond array ownership, the language needs a mechanism to express "this function uses mutable state internally but is pure externally." Algebraic effects with row polymorphism, as in Koka, provide the cleanest solution. A state effect handler encapsulates mutation:

```
handle state(initialBodies) in
  repeat 50_000_000 (fn () →
    advance(dt)  // uses get/set on bodies internally
  )
```

Outside the handler, the computation is referentially transparent. Inside, the compiler emits direct load/store operations to a stack-allocated state variable.

The critical optimization insight is that **most numeric effects are tail-resumptive** — the handler's last action is to resume the computation. Tail-resumptive handlers compile to simple closure calls with zero control-flow overhead, as demonstrated by Koka's evidence-passing compilation and recent work on zero-overhead lexical effect handlers. A JIT compiler can additionally specialize handler dispatch at runtime when the handler is statically known, converting effect operations to direct function calls or even inline code.

For N-body specifically, the effect signature would be something like `advance : () → <state<Bodies>, pure> ()`, indicating local mutable state that doesn't escape. The compiler sees this signature and knows: (1) the `Bodies` value can live on the stack, (2) `get`/`set` operations compile to `stack_load`/`stack_store`, (3) no heap allocation is needed, and (4) the overall function is pure from the caller's perspective.

### 5. SoA data layout by default, with frontend-driven SIMD emission

For SIMD performance, data layout is more important than any instruction-level optimization. Loading four x-coordinates from a struct-of-arrays layout is a single contiguous `F64X2` load; loading them from array-of-structs requires gather instructions that are 3–5× slower. Futhark made the bold choice to guarantee that **arrays of records are always stored as struct-of-arrays**, transparently transforming the programmer's mental model (an array of bodies) into the machine's preferred layout (separate arrays for each field). `zip` and `unzip` between representations have zero runtime cost.

The language should adopt this approach: `Array Body` where `Body` has 7 `Float64` fields compiles to 7 contiguous `Float64` arrays. Field access `bodies[i].x` compiles to `x_array[i]`. The AoSoA (Array of Structures of Arrays) variant — tiling to SIMD width — should be selected automatically based on the target's vector width.

Because Cranelift provides no auto-vectorization, the frontend must emit SIMD operations explicitly. This is actually tractable for a functional language compiler: `map f xs` over an unboxed `Float64` array lowers to a loop processing elements in `F64X2` pairs (Cranelift's well-supported 128-bit SIMD), with a scalar epilogue for remainders. The purity guarantee means no aliasing analysis is needed — `xs` and the output are provably independent.

For the N-body inner loop specifically, the frontend should:

- Precompute all 10 pairwise deltas in SoA layout (3 arrays of 10 doubles each)
- Process pairs two at a time using `F64X2` SIMD operations
- Emit `fma` instructions for force accumulation
- Unroll the fixed-size loops (10 pairs, 5 bodies) completely since Cranelift won't do this

### 6. Region-based memory with stack allocation for hot loops

The memory management strategy must ensure **zero allocation in the inner loop**. The hierarchy of mechanisms, from most to least preferred:

**Stack allocation** for fixed-size data. The 5-body array (280 bytes), pairwise delta arrays (240 bytes), and magnitude arrays (80 bytes) all fit in Cranelift stack slots with known alignment. This is the N-body case — declare `StackSlotData::new(280, 3)` (280 bytes, 8-byte aligned) and access via `stack_load`/`stack_store`.

**Region/arena allocation** for variable-size temporaries. When array sizes are known at region entry but not at compile time, a bump allocator initialized at loop entry and freed at loop exit provides amortized O(1) allocation with no GC interaction. MLKit's region inference automates this, placing allocations in the nearest enclosing region and deallocating in LIFO order.

**Destination-passing style** for functions returning arrays. The caller pre-allocates the output buffer (on the stack or in a region) and passes a pointer to the callee, which writes results directly into the destination. This eliminates return-value allocation and enables the caller to control memory placement. Research on the F̃ language showed DPS achieves C-level performance for numeric array code with an order of magnitude reduction in memory consumption compared to GC-based approaches.

**Reference counting** (Perceus-style) as the fallback for shared, escaping values. Koka and Roc demonstrate that precise reference counting with reuse analysis enables "functional but in-place" semantics — when a value's refcount is 1, destructive update is safe. For N-body, refcounting should never be reached in the hot path if the type system and regions are used correctly.

The compiler should verify statically that the hot loop body involves no heap allocation, no GC interaction, and no refcount operations — only register operations and stack-based array access. This is achievable when all values are unboxed, all arrays are stack/region-allocated, and ownership is tracked affinely.

### 7. Strict evaluation with controlled laziness

Haskell's experience on N-body benchmarks demonstrates the cost of laziness in numeric code: every intermediate `Double` is potentially a thunk requiring an enter/eval check and heap allocation for the thunk closure. Optimized Haskell N-body code is littered with `BangPatterns`, `{-# UNPACK #-}` pragmas, and `-funbox-strict-fields` — essentially fighting the language's default evaluation strategy at every turn.

The language should be **strict by default** for all numeric types and expressions. This eliminates thunk allocation, thunk entry checks, and the possibility of space leaks in numeric computations. Lazy evaluation can be opt-in via an explicit `Lazy a` type for cases where it provides algorithmic benefits (infinite streams, short-circuit evaluation), but the default must be strict.

Strict evaluation also simplifies the calling convention: a `Float64` argument is always an evaluated double in an XMM register, never a pointer to a thunk that might trigger arbitrary computation when forced.

## What the compiler must handle beyond language design

Even with all seven design decisions made correctly, the compiler frontend bears significant responsibility because Cranelift delegates optimization work upward. The frontend should implement:

**Loop unrolling** for known-bound loops. N-body's 10-pair and 5-body loops should be fully unrolled in the frontend IR before lowering to CLIF. For variable-bound loops, unrolling by the SIMD width (2 for `F64X2`) with a scalar remainder handles the general case.

**SIMD lowering** as a frontend pass. `map` and `fold` over unboxed arrays lower to SIMD loops. Pairwise operations lower to `F64X2` packed arithmetic. The frontend should also emit `fma` instructions where algebraically valid (multiply-accumulate patterns in force calculation).

**Inlining** aggressively for small functions. Cranelift's inlining is immature, so the frontend should inline all small numeric functions (body-pair force calculation, position update) before generating CLIF. This is essential for eliminating function call overhead in the inner loop.

**Rsqrt approximation** as a recognized pattern. The fast reciprocal square root (`rsqrt` + Newton-Raphson refinement) used in top C implementations saves ~20% by replacing expensive `sqrt`/`div` with multiplies and adds. The compiler can offer this as a `Float64.fast_rsqrt` intrinsic or recognize the pattern `1.0 / sqrt(x)` and optimize it when fast-math semantics are enabled.

## Lessons from production systems point to a convergent design

The most successful functional language implementations for numeric performance converge on remarkably similar designs. MLton achieves C-competitive performance through whole-program monomorphization yielding unboxed flat arrays. Futhark achieves GPU-competitive performance through automatic SoA layout and uniqueness types for in-place mutation. Roc combines full monomorphization, defunctionalization, and Perceus reference counting. OxCaml (Jane Street's OCaml fork) adds unboxed types with layout kinds (`bits64`, `float64`, `vec128`), local allocation modes, and native SIMD access. Each independently arrived at the same core insight: **the language must give the compiler enough type-level information to choose machine-optimal representations, then get out of the way**.

The specific synthesis for a Cranelift-targeting language would combine Futhark's automatic SoA and uniqueness types, MLton/Roc's monomorphization strategy, Koka's algebraic effects for local mutation, GHC's levity-style kind system for representation control, and Roc's defunctionalization for closures — with a strict-by-default evaluation strategy and a frontend that handles SIMD emission and loop unrolling itself.

## Conclusion

A functional language can approach C performance on N-body through Cranelift JIT, but only if the language design makes this possible — the compiler cannot recover from wrong defaults. **Unboxed numerics** eliminate the 200× boxing penalty. **Monomorphization** enables unboxing across polymorphic boundaries. **Affine types** permit in-place mutation with zero runtime cost. **SoA layout** makes SIMD natural rather than impossible. **Effect-tracked local mutation** keeps inner loops pure externally while mutating internally. **Stack/region allocation** guarantees zero GC interaction in hot paths. **Strict evaluation** eliminates thunk overhead. And because Cranelift intentionally omits auto-vectorization, loop unrolling, and advanced loop transforms, the frontend must implement these passes — which is achievable and arguably preferable, since the frontend has richer type and layout information than any general-purpose backend.

The realistic performance target for such a language on N-body is **1.3–1.8× of optimized C**: the ~14% Cranelift baseline penalty plus modest overhead from any remaining abstraction boundaries. With frontend-emitted SIMD and full loop unrolling, the lower end of that range is achievable. The gap to tier 1 (hand-written SIMD intrinsics) narrows further if the frontend implements pattern-specific optimizations like rsqrt with Newton-Raphson refinement. This represents a dramatic improvement over current functional language performance on this benchmark class, while preserving the safety, composability, and reasoning properties that justify using a functional language in the first place.
