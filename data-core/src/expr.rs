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

//! The binding-expression AST (spec §9.1, D-9 — our own minimal publishing DSL,
//! NOT an Excel-grammar formula dialect). `data-expr` lexes + parses source
//! text into this AST and evaluates it; `data-bind` caches the parsed form.
//!
//! The AST is **never serialized** — the document payload carries expressions
//! as SOURCE TEXT (re-parsed on load), so a registry change that re-indexes
//! [`FnId`] never breaks a saved document (the binding *recipe* is the source
//! string, like a formula). [`FnId`] is an index into the registry-generated
//! function table ([`crate::funcs`]); an unregistered name has no `FnId` and is
//! uncallable by construction.

use compact_str::CompactString;

/// An index into the registry-generated function table
/// ([`crate::funcs::FUNC_META`]). Stable within a build (the build sorts rows by
/// id); never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FnId(pub u16);

/// A parsed binding expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// The literal null.
    Null,
    /// A boolean literal.
    Bool(bool),
    /// A numeric literal.
    Number(f64),
    /// A text literal.
    Text(CompactString),
    /// A record field reference by name (`product_name`) — resolved against the
    /// current record at eval time.
    Field(CompactString),
    /// A query parameter reference (`@since`) — resolved against the bound
    /// param set.
    Param(CompactString),
    /// A unary operation.
    Unary { op: UnaryOp, rhs: Box<Expr> },
    /// A binary operation.
    Binary {
        op: BinOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// A registered function call.
    Call { func: FnId, args: Vec<Expr> },
}

/// Unary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    /// Arithmetic negation.
    Neg,
    /// Logical not.
    Not,
}

/// Binary operators (arithmetic, comparison, logical, and `&` text concat —
/// the publishing-DSL operator set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    /// Text concatenation (`&`).
    Concat,
}
