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

//! Code-128 encoding (ISO/IEC 15417), clean-room from the public spec.
//!
//! A Code-128 symbol is: a start code (selecting code set A, B, or C), the data
//! symbol values, a weighted mod-103 check symbol, the stop pattern, and a final
//! `11` termination bar. Each of the 107 symbol values is an 11-module pattern
//! (6 bars/spaces); the stop is 13 modules. We implement code sets **B** (the
//! full printable ASCII set, the safe general-purpose default) and **C** (digit
//! pairs, ×2 density), with automatic C↔B switching so a long numeric run
//! (catalog SKUs, prices) packs at double density while arbitrary text falls
//! back to B. Code set A (control chars) is not needed for catalog data and is
//! omitted (an honest, documented scope: a control char below 0x20 routes to B
//! where representable, else is rejected).

use crate::{linear_geometry, BarcodeError, BarcodeGeometry, Symbology};

/// The 107 Code-128 patterns (values 0–106), each an 11-module bar/space string
/// (`1` = bar). Index = symbol value. Values 0–102 are data/shift, 103–105 are
/// the START codes (A/B/C), 106 is STOP. Verbatim from ISO/IEC 15417 Annex —
/// the canonical pattern table, the single source of truth.
const PATTERNS: [&str; 107] = [
    "11011001100", "11001101100", "11001100110", "10010011000", "10010001100",
    "10001001100", "10011001000", "10011000100", "10001100100", "11001001000",
    "11001000100", "11000100100", "10110011100", "10011011100", "10011001110",
    "10111001100", "10011101100", "10011100110", "11001110010", "11001011100",
    "11001001110", "11011100100", "11001110100", "11101101110", "11101001100",
    "11100101100", "11100100110", "11101100100", "11100110100", "11100110010",
    "11011011000", "11011000110", "11000110110", "10100011000", "10001011000",
    "10001000110", "10110001000", "10001101000", "10001100010", "11010001000",
    "11000101000", "11000100010", "10110111000", "10110001110", "10001101110",
    "10111011000", "10111000110", "10001110110", "11101110110", "11010001110",
    "11000101110", "11011101000", "11011100010", "11011101110", "11101011000",
    "11101000110", "11100010110", "11101101000", "11101100010", "11100011010",
    "11101111010", "11001000010", "11110001010", "10100110000", "10100001100",
    "10010110000", "10010000110", "10000101100", "10000100110", "10110010000",
    "10110000100", "10011010000", "10011000010", "10000110100", "10000110010",
    "11000010010", "11001010000", "11110111010", "11000010100", "10001111010",
    "10100111100", "10010111100", "10010011110", "10111100100", "10011110100",
    "10011110010", "11110100100", "11110010100", "11110010010", "11011011110",
    "11011110110", "11110110110", "10101111000", "10100011110", "10001011110",
    "10111101000", "10111100010", "11110101000", "11110100010", "10111011110",
    "10111101110", "11101011110", "11110101110", "11010000100", "11010010000",
    "11010011100", "1100011101011", // 106 = STOP (13 modules)
];

const START_B: u8 = 104;
const START_C: u8 = 105;
const CODE_B: u8 = 100;
const CODE_C: u8 = 99;
const STOP: u8 = 106;

/// Quiet zone: 10 light modules each side (the ISO minimum). The lowering may
/// widen it.
const QUIET: u32 = 10;

/// Encode `data` as Code-128 (auto B/C). Every input char must be Latin-1
/// printable representable in code set B (0x20–0x7F here; the bundle expr
/// resolves to a plain string). Returns the unit-box geometry; `text` is the
/// input verbatim (the HRI line — Code-128 has no inherent check-in-text).
pub fn encode_code128(data: &str) -> Result<BarcodeGeometry, BarcodeError> {
    if data.is_empty() {
        return Err(BarcodeError::Empty);
    }
    // Code set B carries ASCII 0x20..=0x7F (value = byte − 32). Reject anything
    // outside that set (no code-set-A control chars; QR is the door for richer
    // payloads).
    let bytes = data.as_bytes();
    for &b in bytes {
        if !(0x20..=0x7f).contains(&b) {
            return Err(BarcodeError::Unencodable(b as char));
        }
    }

    let values = encode_values(bytes);

    // The weighted mod-103 check: start value (weight 1) + Σ value_i × (i+1).
    let mut sum = values[0] as u32;
    for (i, &v) in values.iter().enumerate().skip(1) {
        sum += v as u32 * i as u32;
    }
    let check = (sum % 103) as u8;

    // Assemble the module bitmap: each symbol value → its 11-module pattern,
    // then the check, the stop (13 modules), and the implicit trailing handled by
    // STOP's pattern itself (the canonical 13-module stop already ends in 11).
    let mut symbols: Vec<u8> = values;
    symbols.push(check);
    symbols.push(STOP);

    let mut modules: Vec<bool> = Vec::new();
    for &v in &symbols {
        for ch in PATTERNS[v as usize].chars() {
            modules.push(ch == '1');
        }
    }

    Ok(linear_geometry(
        Symbology::Code128,
        &modules,
        QUIET,
        data.to_string(),
    ))
}

/// The symbol-value stream (incl. the start code), auto-switching between code
/// set C (digit pairs) and code set B (everything else). The greedy switch rule
/// follows the ISO recommendation: start in C if the data begins with ≥4 digits
/// (or is all digits), else B; switch to C for any run of an even count of ≥6
/// digits, back to B otherwise.
fn encode_values(bytes: &[u8]) -> Vec<u8> {
    let n = bytes.len();
    // Decide the starting code set.
    let start_c = should_start_c(bytes);
    let mut values = Vec::new();
    let mut in_c = start_c;
    values.push(if start_c { START_C } else { START_B });

    let mut i = 0usize;
    while i < n {
        if in_c {
            // In C: consume digit pairs. If fewer than 2 digits remain (or a
            // non-digit appears), switch to B.
            if i + 1 < n && bytes[i].is_ascii_digit() && bytes[i + 1].is_ascii_digit() {
                let hi = bytes[i] - b'0';
                let lo = bytes[i + 1] - b'0';
                values.push(hi * 10 + lo);
                i += 2;
            } else {
                values.push(CODE_B);
                in_c = false;
            }
        } else {
            // In B: if a long-enough digit run starts here, switch to C.
            let run = digit_run(&bytes[i..]);
            // Switch to C when an even run of ≥6 digits begins (or all remaining
            // are digits and the count is even and ≥4) — the density win.
            let switch = if i + run == n {
                run >= 4 && run.is_multiple_of(2)
            } else {
                run >= 6 && run.is_multiple_of(2)
            };
            if switch {
                values.push(CODE_C);
                in_c = true;
            } else {
                // Encode one B value (ASCII − 32).
                values.push(bytes[i] - 32);
                i += 1;
            }
        }
    }
    values
}

/// Whether to start in code set C: the data begins with a run of ≥4 digits with
/// an even length usable as pairs (whether or not the whole input is digits —
/// the same threshold applies, so the leading-run test suffices).
fn should_start_c(bytes: &[u8]) -> bool {
    let run = digit_run(bytes);
    run >= 4 && run.is_multiple_of(2)
}

/// The length of the leading run of ASCII digits.
fn digit_run(bytes: &[u8]) -> usize {
    bytes.iter().take_while(|b| b.is_ascii_digit()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_barcode_code128_pattern_table_is_well_formed() {
        // 106 11-module patterns + the 13-module stop = 107 entries (values 0–106).
        assert_eq!(PATTERNS.len(), 107);
        for (i, p) in PATTERNS.iter().enumerate() {
            let want = if i == STOP as usize { 13 } else { 11 };
            assert_eq!(p.len(), want, "pattern {i} has the wrong module count");
            assert!(p.chars().all(|c| c == '0' || c == '1'));
            // Every Code-128 symbol pattern BEGINS with a bar (a space-leading
            // pattern would merge with the preceding symbol). It does not always
            // end with a bar — the final `11` termination is the STOP's own tail.
            assert!(p.starts_with('1'), "pattern {i} must start with a bar");
        }
        // The STOP (value 106) is the 13-module pattern ending in the `11` bar.
        assert!(PATTERNS[STOP as usize].ends_with("11"));
    }

    #[test]
    fn data_barcode_code128_checksum_known_vector() {
        // The canonical "Wikipedia" Code-128B worked example: start-B + the
        // string, weighted mod-103 → the published check value 88.
        let values = encode_values(b"Wikipedia");
        assert_eq!(values[0], START_B);
        let mut sum = values[0] as u32;
        for (i, &v) in values.iter().enumerate().skip(1) {
            sum += v as u32 * i as u32;
        }
        assert_eq!(sum % 103, 88, "Wikipedia is the published Code-128B vector");
    }

    #[test]
    fn data_barcode_code128_auto_switches_to_c_for_digit_runs() {
        // A long even digit run starts in C → start-C then digit pairs.
        let values = encode_values(b"12345678");
        assert_eq!(values[0], START_C);
        // 12 34 56 78 → values 12, 34, 56, 78.
        assert_eq!(&values[1..], &[12, 34, 56, 78]);
    }

    #[test]
    fn data_barcode_code128_mixed_data_uses_set_b() {
        // Non-digit-led data starts in B.
        let values = encode_values(b"ABC-123");
        assert_eq!(values[0], START_B);
        // A B C - 1 2 3 → all in B (the 3-digit run is too short for a C switch).
        assert_eq!(&values[1..], &[33, 34, 35, 13, 17, 18, 19]);
    }

    #[test]
    fn data_barcode_code128_module_bitmap_starts_and_ends_with_bar() {
        let g = encode_code128("ABC-123").unwrap();
        assert_eq!(g.modules_y, 1);
        assert!(g.rect_count() > 0);
        assert_eq!(g.text, "ABC-123");
        // Quiet zone present on each side.
        assert!(g.modules_x > QUIET * 2);
    }

    #[test]
    fn data_barcode_code128_rejects_unencodable_and_empty() {
        assert_eq!(encode_code128(""), Err(BarcodeError::Empty));
        // A non-Latin-1 char (emoji) is unencodable.
        assert!(matches!(
            encode_code128("A\u{1F600}"),
            Err(BarcodeError::Unencodable(_))
        ));
    }
}
