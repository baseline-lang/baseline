# Known Gotchas

Things that will trip you up in Baseline v0.15. These are documented behaviors or known bugs that we plan to fix.

## 1. Parentheses Create Tuples

`(expr)` creates a 1-element tuple, not a grouping expression. This means `(42)` has type `(Int,)`, not `Int`.

```baseline
// WRONG — creates a tuple, not a grouped expression
let x: Int = (42)  // Type error: expected Int, got (Int,)

// RIGHT — just use the value directly
let x: Int = 42

// RIGHT — use let for clarity
let x = 42
```

## 2. Match Arms Are Greedy

The match parser consumes indented lines as arms. If the next line after a match starts with PascalCase (like a module name), it gets consumed as a constructor pattern.

```baseline
// WRONG — Console gets parsed as a match arm pattern
let msg = match x
  Some(v) -> Int.to_string(v)
  None -> "none"
Console.println!(msg)   // ERROR: parsed as match arm, not a statement

// RIGHT — bind the match result with let to terminate the match
let _ = match x
  Some(v) -> Int.to_string(v)
  None -> "none"
let _ = Console.println!(msg)  // now it's a separate statement
```

**Rule:** Always use `let result = match ...` or `let _ = match ...` when you need statements after a match.

## 3. Named Record Constructor Required for Typed Parameters

When a function parameter has a named record type, you must use the named constructor — anonymous records won't match.

```baseline
type Body = { x: Float, y: Float }

fn process(b: Body) -> Float = b.x + b.y

// WRONG — anonymous record doesn't match named type
process({ x: 1.0, y: 2.0 })  // Type error

// RIGHT — use the named constructor
process(Body { x: 1.0, y: 2.0 })
```

## 4. String.slice Takes Length, Not End Index

The third parameter to `String.slice` is the **length** of the substring, not the end index. This differs from most languages.

```baseline
// String.slice(s, start, length)
String.slice("hello", 1, 3)   // => "ell" (3 chars starting at index 1)

// NOT like JavaScript's slice(start, end):
// JS:       "hello".slice(1, 3) => "el"  (indices 1..3)
// Baseline: String.slice("hello", 1, 3) => "ell" (start=1, length=3)
```

## 5. String.char_at Returns Option of String

`String.char_at(s, idx)` returns `Option<String>` at runtime (a single-character string wrapped in Some/None), even though the type signature suggests it returns a character.

```baseline
let ch = String.char_at("hello", 0)  // => Some("h"), not 'h'

// Pattern match to extract
let letter = match String.char_at("hello", 0)
  Some(c) -> c
  None -> ""
```

## 6. Record Update: Use Anonymous Spread

Named record constructor with spread syntax has a JIT bug — field values become `()`. Use anonymous spread instead.

```baseline
type User = { name: String, age: Int }
let alice = User { name: "Alice", age: 30 }

// WRONG — named constructor + spread produces () fields in JIT
let older = User { ..alice, age: 31 }  // Bug: name becomes ()

// RIGHT — anonymous spread works correctly
let older = { ..alice, age: 31 }       // name is "Alice", age is 31
```

## 7. Match Syntax Has No Curly Braces

Unlike Rust, JavaScript, or C-style languages, Baseline match expressions use indentation, not braces.

```baseline
// WRONG — curly braces cause parse error
match value {
  Some(x) -> x
  None -> 0
}

// RIGHT — no braces, just indented arms
match value
  Some(x) -> x
  None -> 0
```

## 8. Int.parse Doesn't Execute at Runtime

`Int.parse(s)` type-checks but returns `()` at runtime. Use `String.to_int(s)` instead.

```baseline
// WRONG — type-checks but returns () at runtime
let n = Int.parse("42")   // => () at runtime

// RIGHT — returns Option<Int>
let n = String.to_int("42")   // => Some(42)
```

## 9. Effect Functions Need the ! Suffix

Forgetting the `!` on effectful calls is a common mistake. The function name itself includes `!`.

```baseline
// WRONG — missing ! on the call
Console.println("hello")   // This calls a non-existent pure function

// RIGHT — include ! in the function name
Console.println!("hello")
```

## 10. Block Return Value

`{ let _ = expr }` returns `()`. If you need to return a value from a block, the last expression (without `let _ =`) is the return value.

```baseline
// Returns () because the last statement is a let binding
let x = {
  let _ = compute()
}  // x is ()

// Returns the result of compute()
let x = {
  let _ = setup()
  compute()     // last expression is the return value
}
```
