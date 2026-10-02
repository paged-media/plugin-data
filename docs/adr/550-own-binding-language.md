# ADR 550 — The binding language is the plugin's own, stored as source text

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-expr`, the expression AST in `data-core/src/expr.rs`, and every binding
  type in `data-core/src/binding.rs` that carries an expression

## Context

A binding connects a query result to a place in the document. Most binding kinds need a
small computation between the record and the page: format a price, join two fields, choose
a text by a condition. That computation is saved with the document and evaluated again each
time the data changes.

The crate documentation states the choice: "Our own minimal, publishing-focused expression
language — NOT an Excel-grammar formula dialect". It shares the value and format vocabulary
with the spreadsheet plugin, "never its code" (`data-expr/src/lib.rs:35-37`).
The repository does not record why.

For the stored form a reason is recorded. A function call in the parsed tree holds a
`FnId`, an index into a table generated at build time from the function registry. The
module comment says the tree is never serialized and the document carries source text, so
that a registry change which re-indexes `FnId` does not break a saved document
(`data-core/src/expr.rs:37-42`).

## Decision

Binding expressions are written in a language defined by this repo (lexer, Pratt parser and
tree-walking evaluator in `data-expr`), and a binding stores its expression as a source
string that is parsed again when it is evaluated.

- Tokens: numbers, single- or double-quoted text, identifiers, `@name` parameter references,
  the operators `+ - * / &` and `= <> < <= > >=`, parentheses and commas. `&` joins text.
- A bare identifier is a field of the current record. `TRUE`, `FALSE` and `NULL` in any
  letter case are literals. An identifier followed by `(` is a function call, looked up by
  name in the registry-generated table at parse time.
- `AND`, `OR` and `NOT` are registry functions, not keyword operators.
- The expression fields are plain `String`s: `expr` on the `Variable`, `Image`, `Barcode`
  and `Visibility` bindings, `ColumnBind.expr`, `TemplateField.expr` and `Rule.when`.
  `Expr` and `FnId` do not derive `Serialize`.
- Errors are values. `eval_str` returns `#NAME` for an unknown function and `#PARSE` for any
  other parse failure; an absent field or parameter evaluates to `Null`; an error operand
  passes through every operator.
- Evaluation does not read the wall clock: the `today` serial is passed into the context.
  The locale changes only the display output of the format functions.

## Evidence

- `data-expr/src/lib.rs:33-50` — the crate statement; the crate depends only on `data-core`
- `data-expr/src/lexer.rs:33-37` — the token set; `AND`/`OR`/`NOT` are functions
- `data-expr/src/parser.rs:143-159`, `:181-196` — identifier handling (call, literal, field)
  and the operator precedences
- `data-core/src/expr.rs:37-50` — the tree is never serialized; `FnId` is never persisted
- `data-core/src/binding.rs:65-73`, `:102-106`, `:236-241`, `:393-399` — expressions as
  `String` in `Binding::Variable`, `Binding::Rule`, `ColumnBind` and `TemplateField`
- `data-expr/src/lib.rs:92-101` — `eval_str`: parse failures become error values
- `data-expr/src/ctx.rs:33-37`, `data-core/src/model.rs:289-294` — injected `today`; the
  locale affects display only
- `data-bind/src/lib.rs:673` — the resolver evaluates a variable binding through `eval_str`

## Alternatives considered

An Excel-grammar formula dialect is named and declined in the crate documentation
(`data-expr/src/lib.rs:35-36`). No reason is given there.

## Consequences

The grammar and the function names are part of the saved-document format. A function is
looked up by name at each parse, so removing or renaming a registry row turns saved
expressions that use it into `#NAME`. A new function is a new registry row (ADR 317, below).

The language has no bracketed or quoted field syntax. A column whose name is not a plain
identifier cannot be referenced; the field-mapping suggestions mark such a column
`mappable: false` with an empty expression (`data-bind/src/mapping.rs:44-47`, `:88-97`).
`is_field_ident` rejects only the upper-case spellings `TRUE`, `FALSE` and `NULL`
(`data-expr/src/lib.rs:89`), while the parser treats those words as literals in any letter
case (`data-expr/src/parser.rs:153`). The test covers the upper-case spellings only
(`data-conformance/tests/mapping.rs:112-114`).

Two comments say `data-bind` caches the parsed form (`data-core/src/expr.rs:35`,
`data-core/src/binding.rs:36`). It does not: every call site in `data-bind/src/lib.rs` goes
through `eval_str`, which parses the source on each evaluation. The tree also defines
`BinOp::And`, `BinOp::Or` and `UnaryOp::Not`, which the evaluator implements
(`data-expr/src/eval.rs:72`, `:103-110`) and the parser never builds.

## Related

- [ADR 317](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/317-registry-driven-dispatch.md) — the function table and dispatch are generated from the registry
- [ADR 314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md) — expression semantics live in Rust behind one wasm module
- [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) — a plugin does not depend on another plugin's code
- [ADR 552](552-binding-is-a-recipe.md) — the document payload that carries these strings
