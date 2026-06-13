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

//! EAN-13 / UPC-A encoding (ISO/IEC 15420), clean-room from the public spec.
//!
//! An EAN-13 symbol is: a left guard `101`, six left-half digits, a centre
//! guard `01010`, six right-half digits, a right guard `101`. Each digit is 7
//! modules. The LEFT six digits are encoded in code set **L** or **G** per a
//! parity pattern selected by the FIRST (13th) digit — that first digit is not
//! drawn as bars; it is carried entirely by the parity choice. The right six
//! digits use code set **R**. A trailing mod-10 check digit makes 13 total.
//!
//! UPC-A is EAN-13 with an implicit leading `0`: a 12-digit UPC-A is encoded as
//! the 13-digit EAN `0` + the 12 digits, so the parity pattern is always the
//! `0` row (all-L left half). We accept the 12-digit UPC form directly.

use crate::{linear_geometry, BarcodeError, BarcodeGeometry, Symbology};

/// The quiet zone EAN/UPC require: 9 modules left, 9 right (the spec minimum is
/// 11 on the left, 7 on the right, but a symmetric 9 is the common print
/// default and keeps the unit box centred; the lowering can widen it).
const QUIET: u32 = 9;

/// L-code (odd parity) 7-module patterns for digits 0–9 (`1` = dark). R-code is
/// the bitwise complement; G-code is L reversed — derived below, so only the L
/// table is a literal (the single source of truth, ISO/IEC 15420 Table).
const L_CODE: [[u8; 7]; 10] = [
    [0, 0, 0, 1, 1, 0, 1], // 0
    [0, 0, 1, 1, 0, 0, 1], // 1
    [0, 0, 1, 0, 0, 1, 1], // 2
    [0, 1, 1, 1, 1, 0, 1], // 3
    [0, 1, 0, 0, 0, 1, 1], // 4
    [0, 1, 1, 0, 0, 0, 1], // 5
    [0, 1, 0, 1, 1, 1, 1], // 6
    [0, 1, 1, 1, 0, 1, 1], // 7
    [0, 1, 1, 0, 1, 1, 1], // 8
    [0, 0, 0, 1, 0, 1, 1], // 9
];

/// The left-half parity pattern selected by the first digit (ISO/IEC 15420):
/// `false` = L (odd), `true` = G (even). The first digit is carried HERE, not as
/// drawn bars. Row 0 (`00000`) is all-L — that is the UPC-A pattern.
#[rustfmt::skip]
const PARITY: [[bool; 6]; 10] = [
    [false, false, false, false, false, false], // 0
    [false, false, true, false, true, true],     // 1
    [false, false, true, true, false, true],     // 2
    [false, false, true, true, true, false],     // 3
    [false, true, false, false, true, true],      // 4
    [false, true, true, false, false, true],      // 5
    [false, true, true, true, false, false],      // 6
    [false, true, false, true, false, true],       // 7
    [false, true, false, true, true, false],       // 8
    [false, true, true, false, true, false],       // 9
];

/// The L pattern reversed = the G-code (even parity) pattern for a digit.
fn g_code(digit: usize) -> [u8; 7] {
    let mut g = L_CODE[digit];
    g.reverse();
    g
}

/// The R-code (right half) = the bitwise complement of L.
fn r_code(digit: usize) -> [u8; 7] {
    let mut r = L_CODE[digit];
    for m in &mut r {
        *m = 1 - *m;
    }
    r
}

/// Parse a fixed-length numeric string into digits, rejecting non-digits.
fn digits(data: &str, expected: usize) -> Result<Vec<u8>, BarcodeError> {
    if data.is_empty() {
        return Err(BarcodeError::Empty);
    }
    let mut out = Vec::with_capacity(data.len());
    for c in data.chars() {
        let d = c.to_digit(10).ok_or(BarcodeError::NonDigit(c))? as u8;
        out.push(d);
    }
    if out.len() != expected {
        return Err(BarcodeError::WrongLength {
            expected,
            got: out.len(),
        });
    }
    Ok(out)
}

/// The EAN/UPC mod-10 check digit over the data digits (odd positions ×3 from
/// the RIGHT of the data, i.e. the standard weighting where the rightmost data
/// digit is weighted ×3). `data` is the digits BEFORE the check (12 for EAN-13,
/// 11 for UPC-A).
pub(crate) fn checksum(data: &[u8]) -> u8 {
    // Weight the rightmost data digit ×3, then alternate ×1, ×3, … leftward.
    let mut sum = 0u32;
    for (i, &d) in data.iter().rev().enumerate() {
        let w = if i % 2 == 0 { 3 } else { 1 };
        sum += d as u32 * w;
    }
    ((10 - (sum % 10)) % 10) as u8
}

/// Encode a 13-digit EAN string. The 13th (check) digit may be SUPPLIED (then
/// it is verified) or OMITTED (12 digits → it is computed). Returns the unit-box
/// geometry; `text` is the full 13-digit canonical string.
pub fn encode_ean13(data: &str) -> Result<BarcodeGeometry, BarcodeError> {
    let d = numeric_with_optional_check(data, 12)?; // 12 data + 1 check = 13
    Ok(encode_ean13_digits(&d, Symbology::Ean13))
}

/// Encode a 12-digit UPC-A string (or 11 digits → the check is computed). UPC-A
/// is the EAN-13 with an implicit leading `0`, so we prepend `0` and encode the
/// resulting 13-digit symbol (the parity pattern is the all-L row 0). `text` is
/// the 12-digit UPC canonical string.
pub fn encode_upca(data: &str) -> Result<BarcodeGeometry, BarcodeError> {
    let d = numeric_with_optional_check(data, 11)?; // 11 data + 1 check = 12 (UPC)
                                                    // EAN-13 view: a leading 0 in front of the 12 UPC digits.
    let mut ean: Vec<u8> = Vec::with_capacity(13);
    ean.push(0);
    ean.extend_from_slice(&d);
    let mut g = encode_ean13_digits(&ean, Symbology::UpcA);
    // The HRI text is the 12-digit UPC form (without the implicit 0).
    g.text = d.iter().map(|n| (b'0' + n) as char).collect();
    Ok(g)
}

/// Parse `data` as `data_len` data digits + an optional supplied check digit.
/// `data_len` data digits → compute the check; `data_len + 1` digits → verify
/// the last as the check. Returns the FULL digit vector (data + check).
fn numeric_with_optional_check(data: &str, data_len: usize) -> Result<Vec<u8>, BarcodeError> {
    if data.is_empty() {
        return Err(BarcodeError::Empty);
    }
    // Try the with-check length first (data_len + 1); fall back to data_len.
    let parsed = match data.chars().count() {
        n if n == data_len + 1 => {
            let all = digits(data, data_len + 1)?;
            let (body, check) = all.split_at(data_len);
            let computed = checksum(body);
            if computed != check[0] {
                return Err(BarcodeError::CheckDigit {
                    expected: computed,
                    got: check[0],
                });
            }
            all
        }
        n if n == data_len => {
            let body = digits(data, data_len)?;
            let check = checksum(&body);
            let mut all = body;
            all.push(check);
            all
        }
        got => {
            return Err(BarcodeError::WrongLength {
                expected: data_len,
                got,
            })
        }
    };
    Ok(parsed)
}

/// Build the EAN-13 module bitmap from a full 13-digit vector (digit[0] is the
/// parity-selecting first digit). `symbology` tags the geometry.
fn encode_ean13_digits(d: &[u8], symbology: Symbology) -> BarcodeGeometry {
    debug_assert_eq!(d.len(), 13);
    let first = d[0] as usize;
    let parity = PARITY[first];

    let mut modules: Vec<bool> = Vec::with_capacity(95);
    // Left guard 101.
    push_pattern(&mut modules, &[1, 0, 1]);
    // Left six digits (positions 1..=6), L or G per the parity pattern.
    for (i, &digit) in d[1..7].iter().enumerate() {
        let pat = if parity[i] {
            g_code(digit as usize)
        } else {
            L_CODE[digit as usize]
        };
        push_pattern(&mut modules, &pat);
    }
    // Centre guard 01010.
    push_pattern(&mut modules, &[0, 1, 0, 1, 0]);
    // Right six digits (positions 7..=12), R-code.
    for &digit in &d[7..13] {
        push_pattern(&mut modules, &r_code(digit as usize));
    }
    // Right guard 101.
    push_pattern(&mut modules, &[1, 0, 1]);

    let text: String = d.iter().map(|n| (b'0' + n) as char).collect();
    linear_geometry(symbology, &modules, QUIET, text)
}

/// Append a `0/1` module pattern (1 = dark) to the bitmap.
fn push_pattern(modules: &mut Vec<bool>, pat: &[u8]) {
    modules.extend(pat.iter().map(|&m| m == 1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_barcode_ean13_checksum_known_vector() {
        // 590123412345_? → the published example checks to 7. Data digits are the
        // first 12 of "5901234123457".
        let body: Vec<u8> = "590123412345"
            .chars()
            .map(|c| c.to_digit(10).unwrap() as u8)
            .collect();
        assert_eq!(checksum(&body), 7);
        // The Wikipedia EAN-13 worked example: 400638133393_1.
        let body2: Vec<u8> = "400638133393"
            .chars()
            .map(|c| c.to_digit(10).unwrap() as u8)
            .collect();
        assert_eq!(checksum(&body2), 1);
    }

    #[test]
    fn data_barcode_upca_checksum_known_vector() {
        // UPC-A worked example 03600029145_2: 11 data digits, check 2.
        let body: Vec<u8> = "03600029145"
            .chars()
            .map(|c| c.to_digit(10).unwrap() as u8)
            .collect();
        assert_eq!(checksum(&body), 2);
    }

    #[test]
    fn data_barcode_ean13_computes_or_verifies_check() {
        // 12 digits → the check is appended.
        let g = encode_ean13("400638133393").unwrap();
        assert_eq!(g.text, "4006381333931");
        // 13 digits with the right check → accepted, identical geometry.
        let g2 = encode_ean13("4006381333931").unwrap();
        assert_eq!(g.rects, g2.rects);
        // 13 digits with a WRONG check → an error, not a silent re-checksum.
        assert!(matches!(
            encode_ean13("4006381333932"),
            Err(BarcodeError::CheckDigit {
                expected: 1,
                got: 2
            })
        ));
    }

    #[test]
    fn data_barcode_ean13_module_count_is_95_plus_quiet() {
        // 3 (guard) + 6×7 + 5 (centre) + 6×7 + 3 (guard) = 95 modules.
        let g = encode_ean13("4006381333931").unwrap();
        assert_eq!(g.modules_x, 95 + 2 * QUIET);
        assert_eq!(g.modules_y, 1);
        // The first bar is the left guard's first module, sitting at the quiet
        // zone (column QUIET).
        let unit = 1.0 / (95.0 + 2.0 * QUIET as f64);
        assert!((g.rects[0].x - QUIET as f64 * unit).abs() < 1e-9);
    }

    #[test]
    fn data_barcode_upca_is_ean13_with_leading_zero() {
        let upc = encode_upca("036000291452").unwrap();
        // The same 12 digits with a leading 0 as EAN-13 → same bars.
        let ean = encode_ean13("0036000291452").unwrap();
        assert_eq!(upc.rects, ean.rects);
        // But the HRI text is the 12-digit UPC form.
        assert_eq!(upc.text, "036000291452");
    }

    #[test]
    fn data_barcode_ean13_rejects_non_digits_and_bad_length() {
        assert!(matches!(
            encode_ean13("40063813339A"),
            Err(BarcodeError::NonDigit('A'))
        ));
        assert!(matches!(
            encode_ean13("123"),
            Err(BarcodeError::WrongLength { .. })
        ));
    }

    #[test]
    fn data_barcode_ean13_r_and_g_codes_are_derived() {
        // R = complement of L; G = L reversed. Spot-check digit 0.
        assert_eq!(r_code(0), [1, 1, 1, 0, 0, 1, 0]);
        let mut rev = L_CODE[3];
        rev.reverse();
        assert_eq!(g_code(3), rev);
    }
}
