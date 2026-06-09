/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

//! The tree-walking evaluator. Pure over a [`EvalCtx`]; bit-stable (`f64`, no
//! tolerance) so re-resolution is idempotent (spec §8, §12.4). Errors propagate
//! as values. Field/param references that are absent resolve to `Null` (the
//! binding's `MissingPolicy` is applied later, by the resolver — spec §9.1).

use std::cmp::Ordering;

use data_core::expr::{BinOp, Expr, UnaryOp};
use data_core::{Value, ValueError};

use crate::ctx::EvalCtx;

/// Evaluate an expression against a context.
pub fn eval(expr: &Expr, ctx: &EvalCtx) -> Value {
    match expr {
        Expr::Null => Value::Null,
        Expr::Bool(b) => Value::Bool(*b),
        Expr::Number(n) => Value::Number(*n),
        Expr::Text(s) => Value::Text(s.clone()),
        Expr::Field(name) => ctx.field(name).unwrap_or(Value::Null),
        Expr::Param(name) => ctx.param(name).unwrap_or(Value::Null),
        Expr::Unary { op, rhs } => apply_unary(*op, eval(rhs, ctx)),
        Expr::Binary { op, lhs, rhs } => apply_binary(*op, eval(lhs, ctx), eval(rhs, ctx)),
        Expr::Call { func, args } => {
            let vals: Vec<Value> = args.iter().map(|a| eval(a, ctx)).collect();
            crate::dispatch(*func, &vals, ctx)
        }
    }
}

fn apply_unary(op: UnaryOp, v: Value) -> Value {
    if let Value::Error(_) = v {
        return v;
    }
    match op {
        UnaryOp::Neg => match v.as_number() {
            Ok(n) => Value::Number(-n),
            Err(e) => Value::Error(e),
        },
        UnaryOp::Not => match v.as_bool() {
            Ok(b) => Value::Bool(!b),
            Err(e) => Value::Error(e),
        },
    }
}

fn apply_binary(op: BinOp, l: Value, r: Value) -> Value {
    // Errors propagate through every operator.
    if l.is_error() {
        return l;
    }
    if r.is_error() {
        return r;
    }
    match op {
        BinOp::Add => num_op(&l, &r, |a, b| a + b),
        BinOp::Sub => num_op(&l, &r, |a, b| a - b),
        BinOp::Mul => num_op(&l, &r, |a, b| a * b),
        BinOp::Div => match (l.as_number(), r.as_number()) {
            (Ok(_), Ok(0.0)) => Value::Error(ValueError::DivByZero),
            (Ok(a), Ok(b)) => Value::Number(a / b),
            (Err(e), _) | (_, Err(e)) => Value::Error(e),
        },
        BinOp::Concat => Value::text(format!("{}{}", l.as_display(), r.as_display())),
        BinOp::Eq => Value::Bool(value_eq(&l, &r)),
        BinOp::Ne => Value::Bool(!value_eq(&l, &r)),
        BinOp::Lt => cmp_op(&l, &r, |o| o == Ordering::Less),
        BinOp::Le => cmp_op(&l, &r, |o| o != Ordering::Greater),
        BinOp::Gt => cmp_op(&l, &r, |o| o == Ordering::Greater),
        BinOp::Ge => cmp_op(&l, &r, |o| o != Ordering::Less),
        BinOp::And => match (l.as_bool(), r.as_bool()) {
            (Ok(a), Ok(b)) => Value::Bool(a && b),
            (Err(e), _) | (_, Err(e)) => Value::Error(e),
        },
        BinOp::Or => match (l.as_bool(), r.as_bool()) {
            (Ok(a), Ok(b)) => Value::Bool(a || b),
            (Err(e), _) | (_, Err(e)) => Value::Error(e),
        },
    }
}

fn num_op(l: &Value, r: &Value, f: impl Fn(f64, f64) -> f64) -> Value {
    match (l.as_number(), r.as_number()) {
        (Ok(a), Ok(b)) => Value::Number(f(a, b)),
        (Err(e), _) | (_, Err(e)) => Value::Error(e),
    }
}

/// Value equality with light coercion: `Null` equals only `Null`; two
/// number-coercible values compare numerically; otherwise their display strings
/// compare.
fn value_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        _ => match (l.as_number(), r.as_number()) {
            (Ok(a), Ok(b)) => a == b,
            _ => l.as_display() == r.as_display(),
        },
    }
}

/// Ordered comparison: numeric when both coerce, else lexicographic on the
/// display strings. A non-comparable pair (NaN) yields `#TYPE`.
fn cmp_op(l: &Value, r: &Value, pick: impl Fn(Ordering) -> bool) -> Value {
    let ord = match (l.as_number(), r.as_number()) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b),
        _ => Some(l.as_display().cmp(&r.as_display())),
    };
    match ord {
        Some(o) => Value::Bool(pick(o)),
        None => Value::Error(ValueError::Type),
    }
}
