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

//! A precedence-climbing (Pratt) parser for the binding DSL. Function names are
//! resolved against the **registry-generated** table
//! ([`data_core::funcs::lookup_func`]) at parse time, so an unregistered
//! function name is a `ParseError::UnknownFunction` — uncallable by
//! construction (spec §12.2). `TRUE`/`FALSE`/`NULL` (case-insensitive, not
//! followed by `(`) are literals; any other bare identifier is a field
//! reference.

use compact_str::CompactString;
use thiserror::Error;

use data_core::expr::{BinOp, Expr, UnaryOp};

use crate::lexer::{lex, LexError, Token};

/// A parse failure. Surfaced by [`crate::eval_str`] as a `#PARSE`/`#NAME` value
/// so a bad binding never panics resolution.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum ParseError {
    #[error("lex error: {0:?}")]
    Lex(LexError),
    #[error("unexpected end of expression")]
    UnexpectedEnd,
    #[error("unexpected token: {0:?}")]
    UnexpectedToken(Token),
    #[error("expected ')'")]
    ExpectedRParen,
    #[error("unknown function: {0}")]
    UnknownFunction(String),
    #[error("trailing tokens after a complete expression")]
    Trailing,
}

/// Parse a source string into the [`Expr`] AST.
pub fn parse(src: &str) -> Result<Expr, ParseError> {
    let tokens = lex(src).map_err(ParseError::Lex)?;
    let mut p = Parser { tokens, pos: 0 };
    let expr = p.parse_expr(0)?;
    if p.pos != p.tokens.len() {
        return Err(ParseError::Trailing);
    }
    Ok(expr)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    /// Precedence-climbing core.
    fn parse_expr(&mut self, min_bp: u8) -> Result<Expr, ParseError> {
        let mut lhs = self.parse_prefix()?;
        while let Some(tok) = self.peek() {
            let Some((lbp, op)) = infix_bp(tok) else {
                break;
            };
            if lbp < min_bp {
                break;
            }
            self.advance();
            // Left-associative: right side binds tighter by one.
            let rhs = self.parse_expr(lbp + 1)?;
            lhs = Expr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    fn parse_prefix(&mut self) -> Result<Expr, ParseError> {
        match self.advance() {
            None => Err(ParseError::UnexpectedEnd),
            Some(Token::Minus) => {
                // Unary minus binds tighter than `* /`.
                let rhs = self.parse_expr(50)?;
                Ok(Expr::Unary {
                    op: UnaryOp::Neg,
                    rhs: Box::new(rhs),
                })
            }
            Some(Token::Number(n)) => Ok(Expr::Number(n)),
            Some(Token::Text(s)) => Ok(Expr::Text(CompactString::from(s))),
            Some(Token::Param(name)) => Ok(Expr::Param(CompactString::from(name))),
            Some(Token::LParen) => {
                let inner = self.parse_expr(0)?;
                match self.advance() {
                    Some(Token::RParen) => Ok(inner),
                    _ => Err(ParseError::ExpectedRParen),
                }
            }
            Some(Token::Ident(name)) => self.parse_ident(name),
            Some(other) => Err(ParseError::UnexpectedToken(other)),
        }
    }

    fn parse_ident(&mut self, name: String) -> Result<Expr, ParseError> {
        if self.peek() == Some(&Token::LParen) {
            // A function call.
            self.advance(); // consume '('
            let args = self.parse_args()?;
            let func = data_core::funcs::lookup_func(&name)
                .ok_or_else(|| ParseError::UnknownFunction(name.clone()))?;
            return Ok(Expr::Call { func, args });
        }
        // A bare identifier: a keyword literal, else a field reference.
        match name.to_ascii_uppercase().as_str() {
            "TRUE" => Ok(Expr::Bool(true)),
            "FALSE" => Ok(Expr::Bool(false)),
            "NULL" => Ok(Expr::Null),
            _ => Ok(Expr::Field(CompactString::from(name))),
        }
    }

    /// Parse a comma-separated argument list up to and including the `)`.
    fn parse_args(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut args = Vec::new();
        if self.peek() == Some(&Token::RParen) {
            self.advance();
            return Ok(args);
        }
        loop {
            args.push(self.parse_expr(0)?);
            match self.advance() {
                Some(Token::Comma) => continue,
                Some(Token::RParen) => break,
                _ => return Err(ParseError::ExpectedRParen),
            }
        }
        Ok(args)
    }
}

/// Left binding power + operator for an infix token (`None` = not infix).
fn infix_bp(tok: &Token) -> Option<(u8, BinOp)> {
    Some(match tok {
        Token::Eq => (10, BinOp::Eq),
        Token::Ne => (10, BinOp::Ne),
        Token::Lt => (10, BinOp::Lt),
        Token::Le => (10, BinOp::Le),
        Token::Gt => (10, BinOp::Gt),
        Token::Ge => (10, BinOp::Ge),
        Token::Amp => (20, BinOp::Concat),
        Token::Plus => (30, BinOp::Add),
        Token::Minus => (30, BinOp::Sub),
        Token::Star => (40, BinOp::Mul),
        Token::Slash => (40, BinOp::Div),
        _ => return None,
    })
}
