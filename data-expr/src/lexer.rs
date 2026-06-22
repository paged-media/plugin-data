/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

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

//! The lexer for the binding DSL. Tokens: numbers, single/double-quoted text
//! literals, identifiers (field names + function names), `@param` references,
//! the operator set (`+ - * / &` and `= <> < <= > >=`), and parentheses/commas.
//! Logical combination is via the `AND`/`OR`/`NOT` *functions* (registry), not
//! keyword operators — so the lexer treats those as plain identifiers.

/// A lexical token.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Number(f64),
    Text(String),
    /// An identifier (field name or function name).
    Ident(String),
    /// `@name` — a query parameter reference.
    Param(String),
    LParen,
    RParen,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    /// `&` — text concatenation.
    Amp,
    Eq,
    /// `<>` — not equal.
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// A lexing failure (a malformed literal or an unexpected character).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LexError {
    UnexpectedChar(char),
    UnterminatedString,
    BadNumber(String),
}

/// Tokenize the source. Whitespace is skipped; the token stream has no explicit
/// end marker (the parser drives off the slice length).
pub fn lex(src: &str) -> Result<Vec<Token>, LexError> {
    let mut out = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => i += 1,
            '(' => {
                out.push(Token::LParen);
                i += 1;
            }
            ')' => {
                out.push(Token::RParen);
                i += 1;
            }
            ',' => {
                out.push(Token::Comma);
                i += 1;
            }
            '+' => {
                out.push(Token::Plus);
                i += 1;
            }
            '-' => {
                out.push(Token::Minus);
                i += 1;
            }
            '*' => {
                out.push(Token::Star);
                i += 1;
            }
            '/' => {
                out.push(Token::Slash);
                i += 1;
            }
            '&' => {
                out.push(Token::Amp);
                i += 1;
            }
            '=' => {
                out.push(Token::Eq);
                i += 1;
            }
            '<' => {
                if chars.get(i + 1) == Some(&'>') {
                    out.push(Token::Ne);
                    i += 2;
                } else if chars.get(i + 1) == Some(&'=') {
                    out.push(Token::Le);
                    i += 2;
                } else {
                    out.push(Token::Lt);
                    i += 1;
                }
            }
            '>' => {
                if chars.get(i + 1) == Some(&'=') {
                    out.push(Token::Ge);
                    i += 2;
                } else {
                    out.push(Token::Gt);
                    i += 1;
                }
            }
            '"' | '\'' => {
                let quote = c;
                i += 1;
                let mut s = String::new();
                loop {
                    match chars.get(i) {
                        None => return Err(LexError::UnterminatedString),
                        Some(&ch) if ch == quote => {
                            // Doubled quote is an escaped quote.
                            if chars.get(i + 1) == Some(&quote) {
                                s.push(quote);
                                i += 2;
                            } else {
                                i += 1;
                                break;
                            }
                        }
                        Some(&ch) => {
                            s.push(ch);
                            i += 1;
                        }
                    }
                }
                out.push(Token::Text(s));
            }
            '@' => {
                i += 1;
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                if i == start {
                    return Err(LexError::UnexpectedChar('@'));
                }
                out.push(Token::Param(chars[start..i].iter().collect()));
            }
            c if c.is_ascii_digit() || (c == '.' && peek_digit(&chars, i + 1)) => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let lit: String = chars[start..i].iter().collect();
                let n: f64 = lit.parse().map_err(|_| LexError::BadNumber(lit.clone()))?;
                out.push(Token::Number(n));
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                out.push(Token::Ident(chars[start..i].iter().collect()));
            }
            other => return Err(LexError::UnexpectedChar(other)),
        }
    }
    Ok(out)
}

fn peek_digit(chars: &[char], i: usize) -> bool {
    chars.get(i).map(|c| c.is_ascii_digit()).unwrap_or(false)
}
