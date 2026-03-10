# RFC-0001: Remove Side-Effect Bang (`!`) Notation

- **Status:** Draft
- **Date:** 2026-03-10
- **Author:** (team)

## Summary

Remove the `!` suffix convention from effectful function names and call sites. Effect tracking would rely entirely on the existing type-level effect annotations (`-> {Http, Console} T`) and the compiler's effect inference, rather than duplicating that information at every call site.

## Motivation

Today, Baseline uses two parallel mechanisms to mark effectful code:

1. **Type-level effect sets** in function signatures: `fn fetch(url: String) -> {Http} String`
2. **Bang suffix** on identifiers: `Http.get!(url)`, `fn main!()`

This redundancy creates problems:

- **Noise.** The `!` appears on every effectful call site. In a typical server handler, nearly every line ends with `!`, adding visual clutter without conveying new information — the effect set in the signature already tells you what effects a function uses.
- **False sense of granularity.** The `!` marks *that* a call is effectful but not *which* effect. The signature `-> {Http, Console} T` is strictly more informative.
- **Friction for LLM generation.** Baseline's design philosophy is "LLM-native." The bang is an extra token that generators must remember to attach, and forgetting it produces a confusing grammar error rather than a type error.
- **Conflation of naming and typing.** Whether a function is effectful is a property of its *type*, not its *name*. Encoding it in the name forces renaming when effect signatures change (e.g., wrapping a pure function to add logging).
- **Precedent.** Languages with mature effect systems (Koka, Eff, Frank, Unison) do not require a naming convention — effects are tracked structurally in the type system.

## Current Behavior

### Grammar

```javascript
// tree-sitter-baseline/grammar.js
identifier: $ => /[a-z_][a-z0-9_]*/,
effect_identifier: $ => token(seq(/[a-z_][a-z0-9_]*/, '!')),
_name: $ => choice($.identifier, $.effect_identifier),
```

`effect_identifier` is a distinct token type that includes the `!` as part of the lexeme.

### Effect Checker

The effect checker (`blc/src/analysis/effects.rs`) uses `effect_identifier` nodes as the **primary signal** for "this call is effectful." When it sees one, it:

1. Extracts the required effect from the call (e.g., `Http.get!` → `Http`)
2. Checks that the enclosing function declares or permits that effect
3. Emits `CAP_001` / `CAP_002` / `CAP_003` if not

### Code Generation

The lowering pass (`blc/src/vm/lower/call.rs`) strips `!` when creating IR:

```rust
if method.ends_with('!') {
    let method_key = method.strip_suffix('!').unwrap_or(&method).to_string();
    return Ok(Expr::PerformEffect { effect: module, method: method_key, args, ty: None });
}
```

The `!` is already erased by the time code reaches the VM — it serves no runtime purpose.

### Type Checker

The type checker (`blc/src/analysis/types/check_node.rs`) treats `effect_identifier` as a fallback: try lookup with `!`, then strip `!` and try again. No semantic enforcement happens here.

## Proposed Change

### 1. Remove `effect_identifier` from the grammar

```javascript
// Before
identifier: $ => /[a-z_][a-z0-9_]*/,
effect_identifier: $ => token(seq(/[a-z_][a-z0-9_]*/, '!')),
_name: $ => choice($.identifier, $.effect_identifier),

// After
identifier: $ => /[a-z_][a-z0-9_]*/,
_name: $ => $.identifier,
```

### 2. Rewrite effect detection to use type resolution

The effect checker currently asks: *"Is this call site an `effect_identifier` node?"*

After this change it would ask: *"Does the callee's resolved type include a non-empty effect set?"*

For qualified calls (`Module.method`), the module prefix already identifies the effect — `Http.get` implies `Http`. For unqualified calls, the compiler resolves the callee in the symbol table and inspects its declared effect set.

This information already exists in the compiler; the `!` is a redundant syntactic shortcut for it.

### 3. Update `PerformEffect` lowering

Instead of detecting `method.ends_with('!')`, the lowering pass would emit `PerformEffect` when the callee is a known effect operation (determined by the module system and effect declarations).

### 4. Update all `.bl` source files

Mechanical transformation — strip `!` from all identifiers:

```
# Approximate scope
~191 files, ~785 call sites, ~142 function declarations
```

## Before / After

### HTTP handler

```baseline
// Before
fn main!() -> {Http, Console} () = {
  let response = Http.get!("https://example.com")
  Console.println!("Status: ${response.status}")
  Console.println!(response.body)
}

// After
fn main() -> {Http, Console} () = {
  let response = Http.get("https://example.com")
  Console.println("Status: ${response.status}")
  Console.println(response.body)
}
```

### Middleware

```baseline
// Before
fn timer(req: Request, next: Unknown) -> {Http, Time} Result<Response, HttpError> = {
  let start = Time.now!()
  let res = next(req)?
  let elapsed = Time.now!() - start
  Ok(res |> Response.with_header("X-Response-Time-Ms", Int.to_string(elapsed)))
}

// After
fn timer(req: Request, next: Unknown) -> {Http, Time} Result<Response, HttpError> = {
  let start = Time.now()
  let res = next(req)?
  let elapsed = Time.now() - start
  Ok(res |> Response.with_header("X-Response-Time-Ms", Int.to_string(elapsed)))
}
```

### Interactive loop

```baseline
// Before
fn loop!(sum: Int) -> Int = {
  let line = Console.read_line!()
  if line == "" then sum
  else match String.to_int(line)
    Some(n) -> loop!(sum + n)
    None -> {
      let _ = Console.println!("not a number, skipping")
      loop!(sum)
    }
}

// After
fn loop(sum: Int) -> Int = {
  let line = Console.read_line()
  if line == "" then sum
  else match String.to_int(line)
    Some(n) -> loop(sum + n)
    None -> {
      let _ = Console.println("not a number, skipping")
      loop(sum)
    }
}
```

## Impact

### Files requiring changes

| Area | Scope |
|------|-------|
| Grammar (`grammar.js`) | Remove `effect_identifier` rule |
| Effect checker (`analysis/effects.rs`) | Rewrite detection (~200 lines) |
| Type checker (`analysis/types/check_node.rs`) | Remove `effect_identifier` branch |
| Lowering (`vm/lower/call.rs`) | Replace bang-based `PerformEffect` detection |
| Lowering (`vm/lower/mod.rs`) | Remove `effect_identifier` match arm |
| `.bl` example/test files | ~191 files, mechanical |
| Docs (`tour.md`, `getting-started.md`, `error-catalog.md`, `stdlib-reference.md`) | Update prose and examples |
| Editor extensions (Zed, VS Code) | Update syntax highlighting |

### Error codes affected

- **CAP_001** (unauthorized effect): Detection logic changes, error message stays the same.
- **CAP_002** (effect in restrict block): Same.
- **CAP_003** (@pure violation): Same.

Error semantics are unchanged — only the detection mechanism shifts from syntactic to semantic.

### Risk assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Effect checker rewrite misses cases | Medium | Existing conformance tests (`tests/`) cover all CAP error codes; run full suite after rewrite |
| `.bl` bulk rename introduces errors | Low | Scripted replacement + `blc check` on every file |
| Grammar conflicts after removing token | Low | `effect_identifier` is self-contained; removing it simplifies the grammar |
| User confusion (muscle memory) | Low | v0.1 bootstrap phase; small user base |

## Alternatives Considered

### A. Keep `!` but make it optional

Allow both `Http.get()` and `Http.get!()`. Rejected because it creates inconsistency — two ways to write the same thing — and still requires maintaining the `effect_identifier` token.

### B. Move `!` to the *signature* only (not call sites)

Require `fn fetch!(...) -> {Http} T` but allow `Http.get(url)` at call sites. Rejected because it's half a measure — still encodes effect information in the name.

### C. Do nothing

Keep the current design. The `!` is harmless. However, it adds cognitive and syntactic overhead that compounds as programs grow, and it diverges from the direction of modern effect-typed languages.

## Migration

1. Grammar change + compiler update (single PR)
2. Bulk `sed` pass over all `.bl` files to strip `!` from identifiers
3. Run `blc check` across all examples and tests
4. Update documentation

All changes are mechanical and can be done atomically.

## Open Questions

1. **Should `!` be reserved for future use?** (e.g., macros, unsafe blocks) — If so, the grammar should reject `!` in identifiers with a clear error message rather than silently accepting it.
2. **Effect inference scope** — Without the syntactic marker, should the compiler require explicit effect annotations on all public functions, or continue allowing full inference?
