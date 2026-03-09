# Baseline JIT Review — Issues to Address

## Soundness

### S1: `Send` impl safety invariant undocumented

**File:** `mod.rs:114–131`

The `unsafe impl Send for JitProgram` argument relies on `_heap_roots` outliving all JIT invocations. If a `*const u8` from `dispatch` is extracted via `get_fn()` and called after the `JitProgram` is dropped, the baked-in pointer-sized integers in JIT code dereference freed `_heap_roots` memory. The invariant that dispatch pointers never outlive the program is not enforced or documented.

**Action:** Add a `# Safety invariant` doc comment on `JitProgram` stating that callers must not retain or call pointers from `dispatch` or `fn_table` beyond the lifetime of the `JitProgram`. Consider wrapping `get_fn` to return a lifetime-bound reference type instead of a raw pointer.

---

### S2: `try_speculate_call_unboxed` evaluates base case eagerly

**File:** `compile.rs:1534`

In the unboxed speculation path, `base_val` is compiled *before* the branch, meaning the base-case expression executes unconditionally. The boxed version (`try_speculate_call`, line 1085) correctly compiles `base_expr` inside the `base_block`. This is safe today because `is_simple_base_case` restricts to pure scalars, but if the predicate is ever loosened to include `GetField` or `CallDirect`, side effects would execute on the wrong path.

**Action:** Add a comment explaining why eager evaluation is safe here. Alternatively, restructure to match the boxed version by compiling `base_expr` inside the base block.

---

### S3: `compile_try` assumes Result-or-Option, never nested

**File:** `compile_pattern.rs:1014–1015`

Both `jit_is_err` and `jit_is_none` are called unconditionally on the same value. An `Ok(None)` value would match `jit_is_none` and early-return the inner `None`, bypassing the `Ok` wrapper. This is correct only if the IR guarantees `try` is never applied to `Result<Option<T>>` or similar nested types.

**Action:** Add a doc comment or debug assertion stating the invariant that `Try` expressions are only used on flat `Result` or `Option` types, never nested. If nested types are possible, check the tag hierarchy (e.g., check `is_err` first and only check `is_none` on non-Result values).

---

### S4: Server handler panics not caught

**File:** `server.rs:1071–1075`

`run_entry_nvalue` wraps JIT execution in `catch_unwind`, but the server calls handlers directly through trampolines via `call_with_middleware` with no `catch_unwind` wrapper. A JIT handler panic unwinds through the async Tokio runtime and likely aborts the process. The `mem::forget(request_nv)` on line 1073 also means the request NValue leaks if the handler panics before the RC scope exit runs.

**Action:** Wrap `call_with_middleware` in `catch_unwind(AssertUnwindSafe(...))`. On panic, drain the arena / reset RC state, log the error, and return a 500 response. This mirrors the safety pattern already established in `run_entry_nvalue`.

---

## Correctness

### C1: Verify `jit_function_fn_ptr` does not consume callee

**File:** `compile.rs:3041, 3067–3069`

In `compile_call_value`, the function path calls `jit_function_fn_ptr(callee_val)` to extract the pointer, then later decrefs `callee_val`. If `jit_function_fn_ptr` consumes ownership (decrefs internally), this produces a double-free. The closure path avoids this because `callee_val` is passed as param[0] and the callee's scope handles the decref.

**Action:** Audit `jit_function_fn_ptr` in `baseline_rt::helpers` to confirm it borrows without consuming. Add a comment at the call site documenting the ownership contract.

---

### C2: RC correctness for `For` loop bindings captured in closures

**File:** `compile_pattern.rs:962–964`

The for loop decrefs the previous iteration's binding at the start of each new iteration. If the loop body captures the binding in a closure (via `MakeClosure`), the closure must incref the captured value. If `jit_make_closure` does *not* incref captures, the decref on the next iteration drops a value the closure still references.

**Action:** Verify that `jit_make_closure` increfs each captured value. Add a test: a for loop that captures the binding in a closure returned from the loop, then calls the closure after the loop exits.

---

### C3: `run_entry` silently reinterprets non-int values

**File:** `mod.rs:245–254`

The `run_entry` method falls through to `nv.raw() as i64` for values that are neither int nor bool. This silently reinterprets NaN-boxed bits (e.g., a record pointer) as a signed integer, producing garbage. Callers have no way to distinguish a valid result from a misinterpreted one.

**Action:** Return `None` for non-int non-bool values, or change the return type to `Option<NValue>` and deprecate `run_entry` in favor of `run_entry_nvalue`. At minimum, add a doc comment warning about the fallthrough behavior.

---

## Maintainability

### M1: `make_helper_sig` and `HELPER_SYMBOLS` are not cross-validated

**File:** `mod.rs:259–386, 1070–1322`

`HELPER_SYMBOLS` (70+ entries) and `make_helper_sig` (250-line match) must be kept in sync manually. Adding a helper to one but not the other causes a silent failure (runtime linker error or missing signature). There is no compile-time or test-time check binding them.

**Action:** Add a `#[cfg(test)]` that iterates `HELPER_SYMBOLS` and calls `make_helper_sig` for each entry, asserting it returns `Ok`. Consider a declarative macro or table that generates both the symbol list and signatures from a single definition.

---

### M2: `FnCompileCtx` has 26 fields

**File:** `compile.rs:28–80`

The compile context accumulates RC tracking, SRA state, counter flags, AOT state, multi-return info, and more into a single struct. This leads to `clone()` calls to work around borrow checker conflicts (e.g., `self.ir_functions[func_idx].param_types.clone()` on line 2016) and makes it hard to reason about which fields are relevant to which codegen phase.

**Action:** Extract focused sub-structs: `RcState { rc_enabled, scalar_values, rc_scope_stack }`, `SraState { sra_records, param_sra_original, sra_hot_vars }`, and `AotState { aot_strings, aot_native_ids }`. The main context holds references to these, reducing field count and clarifying ownership.

---

### M3: `JitError` is a single-variant wrapper around `String`

**File:** `mod.rs:57–81`

`JitError::Message(String)` adds no information over a bare `String`. The `From<&str>` and `From<String>` impls confirm it's only ever used as a string.

**Action:** Either add structured variants (e.g., `UnsupportedExpr { expr_kind: &'static str, func_name: String }`, `HelperNotFound(String)`, `CraneliftError(String)`) for better diagnostics, or simplify to `type JitError = String` and remove the wrapper.

---

### M4: `can_jit` returns bare `bool` with no diagnostics

**File:** `analysis.rs:13–15`

When a function fails `can_jit`, the only signal is a `trace` eprintln saying "unsupported constructs" with no detail about *which* construct caused the fallback.

**Action:** Change `can_jit` to return `Result<(), UnsupportedReason>` where `UnsupportedReason` identifies the specific Expr variant. Use this in the trace output. The bool version can be a thin wrapper: `can_jit(f, n).is_ok()`.

---

### M5: Redundant AST walks across analysis passes

**File:** `analysis.rs:475–598`

`compute_unboxed_flags`, `compute_multireturn_info`, and `collect_indirect_targets` each independently walk the full module AST. All three need the call graph and indirect target set.

**Action:** Compute indirect targets and the call graph once, then pass them to both `compute_unboxed_flags` and `compute_multireturn_info`. This avoids three full traversals on large modules.

---

## Performance

### P1: Scratch stack slot grows monotonically

**File:** `compile.rs:956–973`

`spill_to_stack` only replaces the scratch slot when a larger one is needed. If an early call path spills 64 bytes, all subsequent 16-byte spills reuse the oversized slot. For deeply nested functions with many spill points, this wastes stack space.

**Action:** Consider resetting `scratch_slot` at block boundaries or keeping a small pool (e.g., small/medium/large). Alternatively, document this as an acceptable trade-off since stack frames are cheap.

---

### P2: `scalar_values` tracks SSA `Value` indices across blocks

**File:** `compile.rs:66`

Cranelift `Value` indices are per-function SSA values. After block boundaries, the set may contain stale entries for values no longer in scope. Since `mark_scalar` is only called on freshly created values, this doesn't cause bugs today, but it's fragile — a value index could theoretically be reused by Cranelift's internal numbering.

**Action:** Either clear `scalar_values` on block transitions, switch to tracking `Variable`s (which are stable across blocks), or add a comment documenting why the current approach is safe.

---

### P3: Env var reads on every compilation

**File:** `mod.rs:408–438`

`selected_jit_call_conv()` and `jit_counters_enabled()` read environment variables on every call to `compile_inner`. For the server (compile once at startup) this is fine, but incremental compilation scenarios would re-read on each function.

**Action:** Cache the results in a `once_cell::sync::Lazy` or pass them as parameters from the caller.

---

## Test Coverage Gaps

### T1: Missing tests for advanced codegen paths

The test files cover closures, patterns, and RC well, but the following paths have no dedicated tests:

- Multi-return functions (SRA across call boundaries)
- SRA-aware tail calls (`compile_sra_tail_call`)
- Perceus reuse (`Drop` / `Reuse` with `jit_drop_reuse_*` / `jit_make_*_reuse`)
- Base-case speculation (`try_speculate_call` / `try_speculate_call_unboxed`)
- Unboxed↔boxed boundary crossing (calling unboxed function from boxed context and vice versa)
- CoW enum field updates (`try_gen_enum_update` in match arms)
- Multi-return callee reconstruction at call sites

**Action:** Add targeted integration tests for each path. These are the most complex codegen paths and the most likely to regress during refactors.

---

## Minor

### m1: Unused parameter `_entry_call_conv`

**File:** `mod.rs:883`

`create_entry_wrapper` accepts `_entry_call_conv: CallConv` but never uses it (the wrapper uses the platform-default CC by design).

**Action:** Remove the parameter or use it if the intent was to support non-default entry wrapper CCs.

---

### m2: `And`/`Or` RC decref pattern is subtle

**File:** `compile.rs:2144–2196`

In `Expr::And`, `a_val` is decreffed before branching, then the false branch passes a fresh `NV_FALSE` constant. In `Expr::Or`, similarly, `a_val` is decreffed and the true branch passes `NV_TRUE`. This is correct because the result discards `a`'s identity, but the ownership transfer is non-obvious.

**Action:** Add inline comments explaining: "Decref a_val because And/Or semantics discard the original value — the result is either b_val or a fresh bool constant."

---

### m3: Inline HOF list duplicated

**File:** `analysis.rs:94–106, 121–133`

The list of inline HOFs (`List.map`, `List.filter`, etc.) appears twice — once in the AOT path and once in the JIT path of `expr_can_jit`. Adding a new inline HOF requires updating both locations.

**Action:** Extract to a `const INLINE_HOFS: &[&str]` array and reference it in both branches.
