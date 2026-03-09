//! Integration tests for advanced JIT codegen paths (T1).
//!
//! Each test targets a specific complex codegen path that has no dedicated
//! coverage elsewhere: multi-return, SRA tail calls, Perceus reuse,
//! base-case speculation, unboxed/boxed boundary crossing, and CoW enum updates.

use std::collections::HashMap;

use super::tests::*;
use super::*;
use crate::analysis::types::Type;
use crate::vm::ir::{BinOp, Expr, IrFunction, IrModule, MatchArm, Pattern, TagRegistry};
use crate::vm::nvalue::NValue;

fn make_let(name: &str, value: Expr) -> Expr {
    Expr::Let {
        pattern: Box::new(Pattern::Var(name.into())),
        value: Box::new(value),
        ty: None,
    }
}

fn make_get_field(obj: Expr, field: &str) -> Expr {
    Expr::GetField {
        object: Box::new(obj),
        field: field.into(),
        field_idx: None,
        ty: Some(Type::Int),
    }
}

// ---------------------------------------------------------------------------
// 1. Multi-return functions (SRA across call boundaries)
// ---------------------------------------------------------------------------

/// A helper that returns a 2-field all-scalar record qualifies for multi-return.
/// The caller receives N return registers and reconstructs the boxed record.
#[test]
fn jit_multireturn_scalar_record() {
    let record_ty = Type::Record(
        HashMap::from([("x".into(), Type::Int), ("y".into(), Type::Int)]),
        None,
    );

    let make_point = IrFunction {
        name: "make_point".into(),
        params: vec!["x".into(), "y".into()],
        body: Expr::MakeRecord(
            vec![("x".into(), make_var("x")), ("y".into(), make_var("y"))],
            None,
        ),
        ty: Some(Type::Function(
            vec![Type::Int, Type::Int],
            Box::new(record_ty.clone()),
        )),
        param_types: vec![Some(Type::Int), Some(Type::Int)],
        span: dummy_span(),
    };

    let main = IrFunction {
        name: "main".into(),
        params: vec![],
        body: Expr::Block(
            vec![
                make_let(
                    "p",
                    Expr::CallDirect {
                        name: "make_point".into(),
                        args: vec![make_int(3), make_int(7)],
                        ty: Some(record_ty.clone()),
                    },
                ),
                make_binop(
                    BinOp::Add,
                    make_get_field(Expr::Var("p".into(), None), "x"),
                    make_get_field(Expr::Var("p".into(), None), "y"),
                ),
            ],
            None,
        ),
        ty: Some(Type::Int),
        param_types: vec![],
        span: dummy_span(),
    };

    let module = IrModule {
        functions: vec![make_point, main],
        entry: 1,
        tags: TagRegistry::new(),
    };
    assert_eq!(compile_and_run(&module), 10);
}

// ---------------------------------------------------------------------------
// 2. Base-case speculation (boxed path — try_speculate_call)
// ---------------------------------------------------------------------------

/// Recursive function with a simple base case that triggers speculation.
/// fib(n) = if n <= 1 then n else fib(n-1) + fib(n-2)
#[test]
fn jit_base_case_speculation_boxed() {
    let fib_body = Expr::If {
        condition: Box::new(make_bool_binop(BinOp::Le, make_var("n"), make_int(1))),
        then_branch: Box::new(make_var("n")),
        else_branch: Some(Box::new(make_binop(
            BinOp::Add,
            Expr::CallDirect {
                name: "fib".into(),
                args: vec![make_binop(BinOp::Sub, make_var("n"), make_int(1))],
                ty: Some(Type::Int),
            },
            Expr::CallDirect {
                name: "fib".into(),
                args: vec![make_binop(BinOp::Sub, make_var("n"), make_int(2))],
                ty: Some(Type::Int),
            },
        ))),
        ty: Some(Type::Int),
    };

    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "fib".into(),
                params: vec!["n".into()],
                body: fib_body,
                ty: Some(Type::Int),
                param_types: vec![Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "fib".into(),
                    args: vec![make_int(5)],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 1,
        tags: TagRegistry::new(),
    };
    assert_eq!(compile_and_run(&module), 5);
}

// ---------------------------------------------------------------------------
// 3. Base-case speculation (unboxed path — try_speculate_call_unboxed)
// ---------------------------------------------------------------------------

/// Scalar-only recursive function triggers unboxed speculation.
/// countdown(n) = if n <= 0 then 0 else countdown(n - 1)
#[test]
fn jit_base_case_speculation_unboxed() {
    let countdown_body = Expr::If {
        condition: Box::new(make_bool_binop(BinOp::Le, make_var("n"), make_int(0))),
        then_branch: Box::new(make_int(0)),
        else_branch: Some(Box::new(Expr::CallDirect {
            name: "countdown".into(),
            args: vec![make_binop(BinOp::Sub, make_var("n"), make_int(1))],
            ty: Some(Type::Int),
        })),
        ty: Some(Type::Int),
    };

    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "countdown".into(),
                params: vec!["n".into()],
                body: countdown_body,
                ty: Some(Type::Int),
                param_types: vec![Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "countdown".into(),
                    args: vec![make_int(100)],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 1,
        tags: TagRegistry::new(),
    };

    let indirect = collect_indirect_targets(&module);
    let unboxed = compute_unboxed_flags(&module, &indirect);
    assert!(unboxed[0], "countdown should be unboxed");
    assert_eq!(compile_and_run(&module), 0);
}

/// Base case in the else branch. Speculation must check both branches.
/// f(x, y) = if x > y then f(x - 1, y) else y
#[test]
fn jit_base_case_speculation_else_branch() {
    let f_body = Expr::If {
        condition: Box::new(make_bool_binop(BinOp::Gt, make_var("x"), make_var("y"))),
        then_branch: Box::new(Expr::CallDirect {
            name: "f".into(),
            args: vec![
                make_binop(BinOp::Sub, make_var("x"), make_int(1)),
                make_var("y"),
            ],
            ty: Some(Type::Int),
        }),
        else_branch: Some(Box::new(make_var("y"))),
        ty: Some(Type::Int),
    };

    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "f".into(),
                params: vec!["x".into(), "y".into()],
                body: f_body,
                ty: Some(Type::Int),
                param_types: vec![Some(Type::Int), Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "f".into(),
                    args: vec![make_int(5), make_int(3)],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 1,
        tags: TagRegistry::new(),
    };
    assert_eq!(compile_and_run(&module), 3);
}

// ---------------------------------------------------------------------------
// 4. Unboxed↔boxed boundary crossing
// ---------------------------------------------------------------------------

/// Chain: boxed main → unboxed quad → unboxed double.
/// Verifies boxing/unboxing at each boundary.
#[test]
fn jit_unboxed_boxed_boundary_chain() {
    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "double".into(),
                params: vec!["n".into()],
                body: make_binop(BinOp::Mul, make_var("n"), make_int(2)),
                ty: Some(Type::Int),
                param_types: vec![Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "quad".into(),
                params: vec!["n".into()],
                body: Expr::CallDirect {
                    name: "double".into(),
                    args: vec![Expr::CallDirect {
                        name: "double".into(),
                        args: vec![make_var("n")],
                        ty: Some(Type::Int),
                    }],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "quad".into(),
                    args: vec![make_int(5)],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 2,
        tags: TagRegistry::new(),
    };

    let indirect = collect_indirect_targets(&module);
    let unboxed = compute_unboxed_flags(&module, &indirect);
    assert!(unboxed[0], "double should be unboxed");
    assert!(unboxed[1], "quad should be unboxed");
    assert!(!unboxed[2], "main (entry) must stay boxed");
    assert_eq!(compile_and_run(&module), 20);
}

/// Bool return across unboxed→boxed boundary (raw 0/1 → NaN-boxed bool).
#[test]
fn jit_unboxed_boxed_bool_boundary() {
    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "is_positive".into(),
                params: vec!["n".into()],
                body: make_bool_binop(BinOp::Gt, make_var("n"), make_int(0)),
                ty: Some(Type::Bool),
                param_types: vec![Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "is_positive".into(),
                    args: vec![make_int(42)],
                    ty: Some(Type::Bool),
                },
                ty: Some(Type::Bool),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 1,
        tags: TagRegistry::new(),
    };

    let indirect = collect_indirect_targets(&module);
    let unboxed = compute_unboxed_flags(&module, &indirect);
    assert!(unboxed[0], "is_positive should be unboxed");
    assert!(compile_and_run_bool(&module));
}

// ---------------------------------------------------------------------------
// 5. Perceus reuse (Drop + Reuse with jit_drop_reuse_* / jit_make_*_reuse)
// ---------------------------------------------------------------------------

/// Drop an enum and reuse the allocation for a new enum variant.
#[test]
fn jit_perceus_reuse_enum() {
    let module = IrModule {
        functions: vec![IrFunction {
            name: "main".into(),
            params: vec![],
            body: Expr::Block(
                vec![
                    make_let(
                        "x",
                        Expr::MakeEnum {
                            tag: "Some".into(),
                            payload: Box::new(make_int(42)),
                            ty: None,
                        },
                    ),
                    Expr::Drop {
                        name: "x".into(),
                        token: Some("_reuse".into()),
                        body: Box::new(Expr::Reuse {
                            token: "_reuse".into(),
                            alloc: Box::new(Expr::MakeEnum {
                                tag: "Some".into(),
                                payload: Box::new(make_int(99)),
                                ty: None,
                            }),
                        }),
                    },
                ],
                None,
            ),
            ty: None,
            param_types: vec![],
            span: dummy_span(),
        }],
        entry: 0,
        tags: TagRegistry::new(),
    };

    let nv = compile_and_run_nvalue(&module);
    assert!(nv.is_heap(), "Expected heap value (enum), got: {}", nv);
    let (tag, _payload) = nv.as_enum().expect("Expected enum");
    assert_eq!(&**tag, "Some");
}

/// Drop a tuple and reuse for a new tuple.
#[test]
fn jit_perceus_reuse_tuple() {
    let module = IrModule {
        functions: vec![IrFunction {
            name: "main".into(),
            params: vec![],
            body: Expr::Block(
                vec![
                    make_let(
                        "t",
                        Expr::MakeTuple(vec![make_int(1), make_int(2)], None),
                    ),
                    Expr::Drop {
                        name: "t".into(),
                        token: Some("_reuse".into()),
                        body: Box::new(Expr::Reuse {
                            token: "_reuse".into(),
                            alloc: Box::new(Expr::MakeTuple(
                                vec![make_int(10), make_int(20)],
                                None,
                            )),
                        }),
                    },
                ],
                None,
            ),
            ty: None,
            param_types: vec![],
            span: dummy_span(),
        }],
        entry: 0,
        tags: TagRegistry::new(),
    };

    let nv = compile_and_run_nvalue(&module);
    assert!(nv.is_heap(), "Expected heap value (tuple), got: {}", nv);
}

/// Drop a record and reuse for a new record.
#[test]
fn jit_perceus_reuse_record() {
    let module = IrModule {
        functions: vec![IrFunction {
            name: "main".into(),
            params: vec![],
            body: Expr::Block(
                vec![
                    make_let(
                        "r",
                        Expr::MakeRecord(
                            vec![("a".into(), make_int(1)), ("b".into(), make_int(2))],
                            None,
                        ),
                    ),
                    Expr::Drop {
                        name: "r".into(),
                        token: Some("_reuse".into()),
                        body: Box::new(Expr::Reuse {
                            token: "_reuse".into(),
                            alloc: Box::new(Expr::MakeRecord(
                                vec![("a".into(), make_int(10)), ("b".into(), make_int(20))],
                                None,
                            )),
                        }),
                    },
                ],
                None,
            ),
            ty: None,
            param_types: vec![],
            span: dummy_span(),
        }],
        entry: 0,
        tags: TagRegistry::new(),
    };

    let nv = compile_and_run_nvalue(&module);
    assert!(nv.is_heap(), "Expected heap value (record), got: {}", nv);
}

// ---------------------------------------------------------------------------
// 6. CoW enum field updates (try_gen_enum_update in match arms)
// ---------------------------------------------------------------------------

/// match x { Some(v) -> Some(v + 1) } triggers CoW enum update.
#[test]
fn jit_cow_enum_update() {
    let module = IrModule {
        functions: vec![IrFunction {
            name: "main".into(),
            params: vec![],
            body: Expr::Block(
                vec![
                    make_let(
                        "x",
                        Expr::MakeEnum {
                            tag: "Some".into(),
                            payload: Box::new(make_int(41)),
                            ty: None,
                        },
                    ),
                    Expr::Match {
                        subject: Box::new(Expr::Var("x".into(), None)),
                        arms: vec![
                            MatchArm {
                                pattern: Pattern::Constructor(
                                    "Some".into(),
                                    vec![Pattern::Var("v".into())],
                                ),
                                body: Expr::MakeEnum {
                                    tag: "Some".into(),
                                    payload: Box::new(make_binop(
                                        BinOp::Add,
                                        Expr::Var("v".into(), Some(Type::Int)),
                                        make_int(1),
                                    )),
                                    ty: None,
                                },
                                guard: None,
                            },
                            MatchArm {
                                pattern: Pattern::Constructor("None".into(), vec![]),
                                body: Expr::MakeEnum {
                                    tag: "None".into(),
                                    payload: Box::new(Expr::Unit),
                                    ty: None,
                                },
                                guard: None,
                            },
                        ],
                        ty: None,
                    },
                ],
                None,
            ),
            ty: None,
            param_types: vec![],
            span: dummy_span(),
        }],
        entry: 0,
        tags: TagRegistry::new(),
    };

    let nv = compile_and_run_nvalue(&module);
    assert!(nv.is_heap(), "Expected enum, got: {}", nv);
    let (tag, payload) = nv.as_enum().expect("Expected enum");
    assert_eq!(&**tag, "Some");
    assert!(payload.is_int());
    assert_eq!(payload.as_int(), 42);
}

// ---------------------------------------------------------------------------
// 7. Multi-return callee reconstruction at call sites
// ---------------------------------------------------------------------------

/// Multi-return function called from two sites. Verifies reconstruction.
#[test]
fn jit_multireturn_multiple_call_sites() {
    let record_ty = Type::Record(
        HashMap::from([("fst".into(), Type::Int), ("snd".into(), Type::Int)]),
        None,
    );

    let pair = IrFunction {
        name: "pair".into(),
        params: vec!["a".into(), "b".into()],
        body: Expr::MakeRecord(
            vec![("fst".into(), make_var("a")), ("snd".into(), make_var("b"))],
            None,
        ),
        ty: Some(Type::Function(
            vec![Type::Int, Type::Int],
            Box::new(record_ty.clone()),
        )),
        param_types: vec![Some(Type::Int), Some(Type::Int)],
        span: dummy_span(),
    };

    // pair(1, 2).fst + pair(3, 4).snd = 1 + 4 = 5
    let main = IrFunction {
        name: "main".into(),
        params: vec![],
        body: Expr::Block(
            vec![
                make_let(
                    "p1",
                    Expr::CallDirect {
                        name: "pair".into(),
                        args: vec![make_int(1), make_int(2)],
                        ty: Some(record_ty.clone()),
                    },
                ),
                make_let(
                    "p2",
                    Expr::CallDirect {
                        name: "pair".into(),
                        args: vec![make_int(3), make_int(4)],
                        ty: Some(record_ty.clone()),
                    },
                ),
                make_binop(
                    BinOp::Add,
                    make_get_field(Expr::Var("p1".into(), None), "fst"),
                    make_get_field(Expr::Var("p2".into(), None), "snd"),
                ),
            ],
            None,
        ),
        ty: Some(Type::Int),
        param_types: vec![],
        span: dummy_span(),
    };

    let module = IrModule {
        functions: vec![pair, main],
        entry: 1,
        tags: TagRegistry::new(),
    };
    assert_eq!(compile_and_run(&module), 5);
}

// ---------------------------------------------------------------------------
// 8. SRA-aware tail calls (compile_sra_tail_call)
// ---------------------------------------------------------------------------

/// Tail-recursive function with a record parameter that triggers SRA.
/// sum_xy(p, acc) = if p.x <= 0 then acc else sum_xy({..p, x: p.x - 1}, acc + p.y)
/// sum_xy({x: 3, y: 10}, 0) = 30
#[test]
fn jit_sra_tail_call() {
    let record_type = Type::Record(
        HashMap::from([("x".into(), Type::Int), ("y".into(), Type::Int)]),
        None,
    );

    let p_var = || Expr::Var("p".into(), Some(record_type.clone()));
    let p_x = || Expr::GetField {
        object: Box::new(p_var()),
        field: "x".into(),
        field_idx: None,
        ty: Some(Type::Int),
    };
    let p_y = || Expr::GetField {
        object: Box::new(p_var()),
        field: "y".into(),
        field_idx: None,
        ty: Some(Type::Int),
    };

    let body = Expr::If {
        condition: Box::new(make_bool_binop(BinOp::Le, p_x(), make_int(0))),
        then_branch: Box::new(make_var("acc")),
        else_branch: Some(Box::new(Expr::TailCall {
            name: "sum_xy".into(),
            args: vec![
                Expr::UpdateRecord {
                    base: Box::new(p_var()),
                    updates: vec![("x".into(), make_binop(BinOp::Sub, p_x(), make_int(1)))],
                    ty: Some(record_type.clone()),
                },
                make_binop(BinOp::Add, make_var("acc"), p_y()),
            ],
            ty: Some(Type::Int),
        })),
        ty: Some(Type::Int),
    };

    let module = IrModule {
        functions: vec![
            IrFunction {
                name: "sum_xy".into(),
                params: vec!["p".into(), "acc".into()],
                body,
                ty: Some(Type::Int),
                param_types: vec![Some(record_type.clone()), Some(Type::Int)],
                span: dummy_span(),
            },
            IrFunction {
                name: "main".into(),
                params: vec![],
                body: Expr::CallDirect {
                    name: "sum_xy".into(),
                    args: vec![
                        Expr::MakeRecord(
                            vec![("x".into(), make_int(3)), ("y".into(), make_int(10))],
                            None,
                        ),
                        make_int(0),
                    ],
                    ty: Some(Type::Int),
                },
                ty: Some(Type::Int),
                param_types: vec![],
                span: dummy_span(),
            },
        ],
        entry: 1,
        tags: TagRegistry::new(),
    };
    assert_eq!(compile_and_run(&module), 30);
}
