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

//! QR Code encoding (ISO/IEC 18004), clean-room from the public spec — **byte
//! mode**, error-correction level **M**, versions **1–10**. Implemented from
//! first principles: the GF(256) Reed–Solomon coder, the matrix module
//! placement (finder / separator / timing / alignment / dark module), the
//! data-bit zig-zag fill, the 8 data masks with penalty scoring, and the format
//! information with its BCH(15,5) code. NO third-party QR library is used (§3
//! license boundary).
//!
//! Scope: byte mode + level M + v1–v10 cover catalog payloads (SKUs, URLs up to
//! ~270 bytes) comfortably. Numeric/alphanumeric mode compaction, the higher
//! versions, ECI, and Kanji mode are an honest scoped follow-on (RFI §6 — a
//! density optimization, never a correctness gap: byte mode encodes everything
//! the others can). A payload past v10's byte capacity is a typed
//! [`crate::BarcodeError::TooLong`], never a panic.

use crate::{BarcodeError, BarcodeGeometry, BarcodeRect, Symbology};

/// Error-correction level M (the catalog default — ~15% recovery, the balance of
/// density and robustness for print).
const QUIET: u32 = 4; // QR mandates a 4-module quiet zone.

/// Per-version (1..=10), level M: (data codewords, ec codewords per block,
/// block count group1, ...). For v1–v10 level M the block structure is simple
/// enough to table directly: `(total_data_codewords, ec_per_block, num_blocks_g1,
/// data_per_block_g1, num_blocks_g2, data_per_block_g2)`. From ISO/IEC 18004
/// Table 9 (error correction characteristics), level M.
struct VersionEc {
    /// Total data codewords for the version at level M.
    data_codewords: usize,
    /// EC codewords per block.
    ec_per_block: usize,
    /// (count, data-codewords) for group 1 blocks.
    g1: (usize, usize),
    /// (count, data-codewords) for group 2 blocks (0,0 when absent).
    g2: (usize, usize),
}

/// Level-M block tables for versions 1–10 (index = version − 1). Verbatim from
/// ISO/IEC 18004 Table 9.
const VERSION_M: [VersionEc; 10] = [
    VersionEc { data_codewords: 16, ec_per_block: 10, g1: (1, 16), g2: (0, 0) }, // v1
    VersionEc { data_codewords: 28, ec_per_block: 16, g1: (1, 28), g2: (0, 0) }, // v2
    VersionEc { data_codewords: 44, ec_per_block: 26, g1: (1, 44), g2: (0, 0) }, // v3
    VersionEc { data_codewords: 64, ec_per_block: 18, g1: (2, 32), g2: (0, 0) }, // v4
    VersionEc { data_codewords: 86, ec_per_block: 24, g1: (2, 43), g2: (0, 0) }, // v5
    VersionEc { data_codewords: 108, ec_per_block: 16, g1: (4, 27), g2: (0, 0) }, // v6
    VersionEc { data_codewords: 124, ec_per_block: 18, g1: (4, 31), g2: (0, 0) }, // v7
    VersionEc { data_codewords: 154, ec_per_block: 22, g1: (2, 38), g2: (2, 39) }, // v8
    VersionEc { data_codewords: 182, ec_per_block: 22, g1: (3, 36), g2: (2, 37) }, // v9
    VersionEc { data_codewords: 216, ec_per_block: 26, g1: (4, 43), g2: (1, 44) }, // v10
];

/// Encode `data` as a byte-mode, level-M QR symbol (the §9.7 2D path). Returns
/// the unit-box geometry (one rect per dark module, incl. a 4-module quiet
/// zone). `text` is empty (QR carries no human-readable line).
pub fn encode_qr(data: &str) -> Result<BarcodeGeometry, BarcodeError> {
    if data.is_empty() {
        return Err(BarcodeError::Empty);
    }
    let payload = data.as_bytes();

    // Pick the smallest version (1..=10) whose level-M byte capacity fits the
    // payload + the byte-mode header (4-bit mode + the length field).
    let (version, ec) = pick_version(payload.len())?;
    let size = 17 + 4 * version; // modules per side (v → 21, 25, …).

    // ── Stage 1: the bit stream (mode + count + data + terminator + pad). ────
    let data_codewords = build_data_codewords(payload, version, ec.data_codewords);

    // ── Stage 2: Reed–Solomon EC + block interleave. ────────────────────────
    let final_codewords = interleave_with_ec(&data_codewords, ec);

    // ── Stage 3: place modules into the matrix (function patterns first). ────
    let mut matrix = Matrix::new(size);
    matrix.place_function_patterns(version);

    // Zig-zag fill the data+EC bits into the non-function modules.
    matrix.place_data_bits(&codewords_to_bits(&final_codewords));

    // ── Stage 4: choose the lowest-penalty mask, apply it, write format info.
    let best_mask = matrix.choose_mask();
    matrix.apply_mask_and_format(best_mask);

    // ── Stage 5: emit one unit-box rect per dark module (+ quiet zone). ──────
    Ok(matrix.to_geometry())
}

/// Pick the smallest v1–v10 whose level-M **byte-mode** capacity holds the
/// payload. The byte-mode overhead is the 4-bit mode indicator + the character
/// count (8 bits for v1–9, 16 bits for v10+).
fn pick_version(len: usize) -> Result<(usize, &'static VersionEc), BarcodeError> {
    for (i, ec) in VERSION_M.iter().enumerate() {
        let version = i + 1;
        let count_bits = if version <= 9 { 8 } else { 16 };
        // Available data bits = data codewords × 8; need 4 (mode) + count + 8×len.
        let need_bits = 4 + count_bits + 8 * len;
        if need_bits <= ec.data_codewords * 8 {
            return Ok((version, ec));
        }
    }
    Err(BarcodeError::TooLong {
        len,
        symbology: "QR (byte mode, level M, v1–v10)",
    })
}

/// Build the data codeword stream: the byte-mode header (mode `0100` + count),
/// the payload bytes, the terminator, bit padding to a byte boundary, then the
/// alternating pad codewords `0xEC 0x11` up to `data_codewords`.
fn build_data_codewords(payload: &[u8], version: usize, data_codewords: usize) -> Vec<u8> {
    let count_bits = if version <= 9 { 8 } else { 16 };
    let mut bits = BitBuffer::new();
    // Mode indicator: byte mode = 0100.
    bits.push_bits(0b0100, 4);
    // Character count.
    bits.push_bits(payload.len() as u32, count_bits);
    // The payload bytes.
    for &b in payload {
        bits.push_bits(b as u32, 8);
    }
    // Terminator: up to 4 zero bits, not exceeding capacity.
    let cap_bits = data_codewords * 8;
    let term = (cap_bits - bits.len()).min(4);
    bits.push_bits(0, term);
    // Pad to a byte boundary.
    while !bits.len().is_multiple_of(8) {
        bits.push_bits(0, 1);
    }
    // Convert to codewords, then pad with the alternating fill.
    let mut cw = bits.to_bytes();
    let pad = [0xEC_u8, 0x11];
    let mut k = 0;
    while cw.len() < data_codewords {
        cw.push(pad[k % 2]);
        k += 1;
    }
    cw
}

/// Reed–Solomon-encode each block, then interleave data then EC codewords per
/// the QR ordering (ISO/IEC 18004 §8.6): all blocks' first data codeword, then
/// their second, …, then all blocks' EC codewords interleaved likewise.
fn interleave_with_ec(data: &[u8], ec: &VersionEc) -> Vec<u8> {
    // Split the data codewords into blocks per the group structure.
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    let mut offset = 0;
    for _ in 0..ec.g1.0 {
        blocks.push(data[offset..offset + ec.g1.1].to_vec());
        offset += ec.g1.1;
    }
    for _ in 0..ec.g2.0 {
        blocks.push(data[offset..offset + ec.g2.1].to_vec());
        offset += ec.g2.1;
    }

    // Per-block EC.
    let ec_blocks: Vec<Vec<u8>> = blocks
        .iter()
        .map(|b| reed_solomon(b, ec.ec_per_block))
        .collect();

    // Interleave data codewords.
    let mut out = Vec::new();
    let max_data = blocks.iter().map(|b| b.len()).max().unwrap_or(0);
    for i in 0..max_data {
        for b in &blocks {
            if i < b.len() {
                out.push(b[i]);
            }
        }
    }
    // Interleave EC codewords (all blocks have `ec_per_block` EC codewords).
    for i in 0..ec.ec_per_block {
        for b in &ec_blocks {
            out.push(b[i]);
        }
    }
    out
}

// ── GF(256) arithmetic for Reed–Solomon (primitive poly 0x11D) ──────────────

/// log / antilog tables for GF(256) with the QR primitive polynomial x^8 + x^4
/// + x^3 + x^2 + 1 (0x11D), generator α = 2. Built once at first use.
struct Gf {
    exp: [u8; 512],
    log: [u8; 256],
}

impl Gf {
    fn new() -> Self {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut x: u16 = 1;
        #[allow(clippy::needless_range_loop)] // i is BOTH the exp index and the log value
        for i in 0..255 {
            exp[i] = x as u8;
            log[x as usize] = i as u8;
            x <<= 1;
            if x & 0x100 != 0 {
                x ^= 0x11D;
            }
        }
        for i in 255..512 {
            exp[i] = exp[i - 255];
        }
        Gf { exp, log }
    }

    fn mul(&self, a: u8, b: u8) -> u8 {
        if a == 0 || b == 0 {
            0
        } else {
            self.exp[self.log[a as usize] as usize + self.log[b as usize] as usize]
        }
    }
}

/// Reed–Solomon EC codewords for one data block: divide the message polynomial
/// (data × x^ec) by the generator polynomial in GF(256); the remainder is the EC
/// codewords.
fn reed_solomon(data: &[u8], ec_len: usize) -> Vec<u8> {
    let gf = Gf::new();
    let generator = rs_generator(&gf, ec_len);
    // Polynomial long division. `residue` starts as the data followed by ec_len
    // zeros; we reduce in place.
    let mut residue = vec![0u8; data.len() + ec_len];
    residue[..data.len()].copy_from_slice(data);
    for i in 0..data.len() {
        let coef = residue[i];
        if coef != 0 {
            for (j, &g) in generator.iter().enumerate() {
                residue[i + j] ^= gf.mul(g, coef);
            }
        }
    }
    residue[data.len()..].to_vec()
}

/// The degree-`ec_len` RS generator polynomial: ∏ (x − α^i) for i in 0..ec_len.
fn rs_generator(gf: &Gf, ec_len: usize) -> Vec<u8> {
    let mut g = vec![1u8];
    for i in 0..ec_len {
        // Multiply g by (x − α^i) = (x + α^i) in GF(256).
        let root = gf.exp[i];
        let mut next = vec![0u8; g.len() + 1];
        for (j, &c) in g.iter().enumerate() {
            next[j] ^= c; // the x·g term
            next[j + 1] ^= gf.mul(c, root); // the α^i·g term
        }
        g = next;
    }
    g
}

// ── Bit buffer ──────────────────────────────────────────────────────────────

struct BitBuffer {
    bits: Vec<bool>,
}

impl BitBuffer {
    fn new() -> Self {
        BitBuffer { bits: Vec::new() }
    }
    fn len(&self) -> usize {
        self.bits.len()
    }
    /// Push the low `n` bits of `value`, MSB first.
    fn push_bits(&mut self, value: u32, n: usize) {
        for i in (0..n).rev() {
            self.bits.push((value >> i) & 1 == 1);
        }
    }
    fn to_bytes(&self) -> Vec<u8> {
        self.bits
            .chunks(8)
            .map(|c| {
                let mut b = 0u8;
                for (i, &bit) in c.iter().enumerate() {
                    if bit {
                        b |= 1 << (7 - i);
                    }
                }
                b
            })
            .collect()
    }
}

/// The bit stream of a codeword vector, MSB first per byte.
fn codewords_to_bits(cw: &[u8]) -> Vec<bool> {
    let mut bits = Vec::with_capacity(cw.len() * 8);
    for &b in cw {
        for i in (0..8).rev() {
            bits.push((b >> i) & 1 == 1);
        }
    }
    bits
}

// ── The QR matrix ───────────────────────────────────────────────────────────

/// A square QR module grid. `dark[i]` is the module colour; `function[i]` marks
/// a function (non-data, non-maskable) module so the data fill + masking skip
/// them.
struct Matrix {
    size: usize,
    dark: Vec<bool>,
    function: Vec<bool>,
}

impl Matrix {
    fn new(size: usize) -> Self {
        Matrix {
            size,
            dark: vec![false; size * size],
            function: vec![false; size * size],
        }
    }

    fn idx(&self, x: usize, y: usize) -> usize {
        y * self.size + x
    }

    fn set(&mut self, x: usize, y: usize, dark: bool, function: bool) {
        let i = self.idx(x, y);
        self.dark[i] = dark;
        if function {
            self.function[i] = true;
        }
    }

    fn is_function(&self, x: usize, y: usize) -> bool {
        self.function[self.idx(x, y)]
    }

    /// Place the finder patterns, separators, timing patterns, the dark module,
    /// the alignment patterns, and reserve the format-information areas.
    fn place_function_patterns(&mut self, version: usize) {
        let n = self.size;
        // Three finder patterns (7×7) at the corners + their separators.
        for &(ox, oy) in &[(0usize, 0usize), (n - 7, 0), (0, n - 7)] {
            self.place_finder(ox, oy);
        }
        // Timing patterns (row 6 and column 6), alternating, between the finders.
        for i in 8..n - 8 {
            let dark = i % 2 == 0;
            self.set(i, 6, dark, true);
            self.set(6, i, dark, true);
        }
        // The dark module (always dark) at (8, 4*version+9).
        self.set(8, 4 * version + 9, true, true);
        // Alignment patterns (v2+).
        self.place_alignment(version);
        // Reserve the format-information modules (filled later) as function so
        // the data fill skips them.
        self.reserve_format();
    }

    /// A 7×7 finder pattern with its 1-module separator, top-left at (ox, oy).
    fn place_finder(&mut self, ox: usize, oy: usize) {
        for dy in 0..7 {
            for dx in 0..7 {
                let dark = dx == 0
                    || dx == 6
                    || dy == 0
                    || dy == 6
                    || (2..=4).contains(&dx) && (2..=4).contains(&dy);
                self.set(ox + dx, oy + dy, dark, true);
            }
        }
        // Separator: the light ring just outside the finder (clamped to the grid).
        let n = self.size as isize;
        for d in -1..=7isize {
            for &(sx, sy) in &[
                (ox as isize + d, oy as isize - 1),
                (ox as isize + d, oy as isize + 7),
                (ox as isize - 1, oy as isize + d),
                (ox as isize + 7, oy as isize + d),
            ] {
                if sx >= 0 && sy >= 0 && sx < n && sy < n {
                    self.set(sx as usize, sy as usize, false, true);
                }
            }
        }
    }

    /// Alignment patterns (5×5) at the version's centre coordinates (skipping
    /// any that overlap a finder).
    fn place_alignment(&mut self, version: usize) {
        let centres = alignment_centres(version);
        let n = self.size;
        for &cy in &centres {
            for &cx in &centres {
                // Skip the three finder corners (top-left, top-right, bottom-left).
                let near_finder =
                    (cy < 8 && (cx < 8 || cx >= n - 8)) || (cx < 8 && cy >= n - 8);
                if near_finder {
                    continue;
                }
                for dy in -2isize..=2 {
                    for dx in -2isize..=2 {
                        let dark = dx.abs() == 2 || dy.abs() == 2 || (dx == 0 && dy == 0);
                        self.set(
                            (cx as isize + dx) as usize,
                            (cy as isize + dy) as usize,
                            dark,
                            true,
                        );
                    }
                }
            }
        }
    }

    /// Reserve the format-information module positions as function (their values
    /// are written in `apply_mask_and_format`).
    fn reserve_format(&mut self) {
        let n = self.size;
        for i in 0..9 {
            // Around the top-left finder.
            if i != 6 {
                self.set(i, 8, false, true);
                self.set(8, i, false, true);
            }
        }
        for i in 0..8 {
            // Around the top-right + bottom-left finders.
            self.set(n - 1 - i, 8, false, true);
            self.set(8, n - 1 - i, false, true);
        }
    }

    /// Fill the data bits into the non-function modules in the QR zig-zag order
    /// (upward/downward two-column sweeps from the bottom-right, skipping the
    /// timing column 6).
    fn place_data_bits(&mut self, bits: &[bool]) {
        let n = self.size as isize;
        let mut bit_idx = 0;
        let mut col = n - 1;
        let mut upward = true;
        while col > 0 {
            if col == 6 {
                col -= 1; // skip the vertical timing column.
            }
            let rows: Vec<isize> = if upward {
                (0..n).rev().collect()
            } else {
                (0..n).collect()
            };
            for y in rows {
                for dx in 0..2 {
                    let x = col - dx;
                    if x < 0 {
                        continue;
                    }
                    let (xu, yu) = (x as usize, y as usize);
                    if self.is_function(xu, yu) {
                        continue;
                    }
                    let bit = bits.get(bit_idx).copied().unwrap_or(false);
                    let i = self.idx(xu, yu);
                    self.dark[i] = bit;
                    bit_idx += 1;
                }
            }
            col -= 2;
            upward = !upward;
        }
    }

    /// Choose the data mask (0..7) with the lowest penalty score: try each,
    /// score the masked matrix, keep the best.
    fn choose_mask(&self) -> u8 {
        let mut best = 0u8;
        let mut best_score = u32::MAX;
        for mask in 0..8u8 {
            let masked = self.with_mask(mask);
            let score = masked.penalty();
            if score < best_score {
                best_score = score;
                best = mask;
            }
        }
        best
    }

    /// A copy of the matrix with `mask` applied to the data modules only.
    fn with_mask(&self, mask: u8) -> Matrix {
        let mut m = Matrix {
            size: self.size,
            dark: self.dark.clone(),
            function: self.function.clone(),
        };
        for y in 0..m.size {
            for x in 0..m.size {
                if m.is_function(x, y) {
                    continue;
                }
                if mask_condition(mask, x, y) {
                    let i = m.idx(x, y);
                    m.dark[i] = !m.dark[i];
                }
            }
        }
        m
    }

    /// Apply the chosen mask in place + write the format-information bits.
    fn apply_mask_and_format(&mut self, mask: u8) {
        for y in 0..self.size {
            for x in 0..self.size {
                if !self.is_function(x, y) && mask_condition(mask, x, y) {
                    let i = self.idx(x, y);
                    self.dark[i] = !self.dark[i];
                }
            }
        }
        self.write_format(mask);
    }

    /// Write the 15-bit format information (level M + mask) with its BCH code,
    /// XOR-masked by 0x5412, into the two reserved format areas.
    fn write_format(&mut self, mask: u8) {
        // The 5-bit format value: the EC-level field (bits 4–3) + the 3-bit mask
        // (bits 2–0). Level M is 0b00, so its shifted field is 0 — the format is
        // just the mask.
        let ec_level_m: u32 = 0b00;
        let format = (ec_level_m << 3) | mask as u32;
        let bits = bch_format(format);
        let n = self.size;
        // bits[0] is the MSB (bit 14). Placement per ISO/IEC 18004 §8.9.
        // Around the top-left finder + split across top-right / bottom-left.
        for i in 0..15 {
            let bit = (bits >> (14 - i)) & 1 == 1;
            // First copy: top-left.
            let (x1, y1) = format_pos_a(i);
            let idx1 = self.idx(x1, y1);
            self.dark[idx1] = bit;
            self.function[idx1] = true;
            // Second copy: around the other two finders.
            let (x2, y2) = format_pos_b(i, n);
            let idx2 = self.idx(x2, y2);
            self.dark[idx2] = bit;
            self.function[idx2] = true;
        }
    }

    /// The QR penalty score (ISO/IEC 18004 §8.8.2) — four rules, summed.
    fn penalty(&self) -> u32 {
        let n = self.size;
        let mut score = 0u32;
        let at = |x: usize, y: usize| self.dark[y * n + x];

        // Rule 1: runs of ≥5 same-colour modules in a row/column.
        for y in 0..n {
            score += line_penalty((0..n).map(|x| at(x, y)));
        }
        for x in 0..n {
            score += line_penalty((0..n).map(|y| at(x, y)));
        }

        // Rule 2: 2×2 blocks of the same colour (+3 each).
        for y in 0..n - 1 {
            for x in 0..n - 1 {
                let c = at(x, y);
                if c == at(x + 1, y) && c == at(x, y + 1) && c == at(x + 1, y + 1) {
                    score += 3;
                }
            }
        }

        // Rule 3: the finder-like 1:1:3:1:1 pattern with a 4-module light run
        // (+40 each), in rows and columns.
        let pat1 = [true, false, true, true, true, false, true, false, false, false, false];
        let pat2 = [false, false, false, false, true, false, true, true, true, false, true];
        for y in 0..n {
            let row: Vec<bool> = (0..n).map(|x| at(x, y)).collect();
            score += 40 * count_subslice(&row, &pat1);
            score += 40 * count_subslice(&row, &pat2);
        }
        for x in 0..n {
            let col: Vec<bool> = (0..n).map(|y| at(x, y)).collect();
            score += 40 * count_subslice(&col, &pat1);
            score += 40 * count_subslice(&col, &pat2);
        }

        // Rule 4: proportion of dark modules deviating from 50%.
        let dark = self.dark.iter().filter(|&&d| d).count();
        let total = n * n;
        let percent = dark * 100 / total;
        let prev = (percent / 5) * 5;
        let next = prev + 5;
        let dev_prev = (prev as i32 - 50).abs() / 5;
        let dev_next = (next as i32 - 50).abs() / 5;
        score += 10 * dev_prev.min(dev_next) as u32;

        score
    }

    /// Emit one unit-box rect per dark module + a 4-module quiet zone.
    fn to_geometry(&self) -> BarcodeGeometry {
        let total = self.size as u32 + 2 * QUIET;
        let unit = 1.0 / total as f64;
        let mut rects = Vec::new();
        for y in 0..self.size {
            for x in 0..self.size {
                if self.dark[self.idx(x, y)] {
                    let px = (QUIET + x as u32) as f64 * unit;
                    let py = (QUIET + y as u32) as f64 * unit;
                    rects.push(BarcodeRect {
                        x: px,
                        y: py,
                        w: unit,
                        h: unit,
                    });
                }
            }
        }
        BarcodeGeometry {
            symbology: Symbology::Qr,
            rects,
            modules_x: total,
            modules_y: total,
            text: String::new(),
        }
    }
}

/// The 8 QR data-mask conditions (ISO/IEC 18004 §8.8.1). `(x, y)` are column,
/// row (i, j in the spec where i = row, j = column — here x = column = j,
/// y = row = i).
fn mask_condition(mask: u8, x: usize, y: usize) -> bool {
    let (i, j) = (y, x);
    match mask {
        0 => (i + j) % 2 == 0,
        1 => i % 2 == 0,
        2 => j % 3 == 0,
        3 => (i + j) % 3 == 0,
        4 => (i / 2 + j / 3) % 2 == 0,
        5 => (i * j) % 2 + (i * j) % 3 == 0,
        6 => ((i * j) % 2 + (i * j) % 3) % 2 == 0,
        7 => ((i + j) % 2 + (i * j) % 3) % 2 == 0,
        _ => false,
    }
}

/// Penalty rule 1 over one line: each run of ≥5 same-colour modules scores
/// `3 + (run − 5)`.
fn line_penalty(line: impl Iterator<Item = bool>) -> u32 {
    let mut score = 0;
    let mut run = 0u32;
    let mut prev: Option<bool> = None;
    for c in line {
        if Some(c) == prev {
            run += 1;
        } else {
            if run >= 5 {
                score += 3 + (run - 5);
            }
            run = 1;
            prev = Some(c);
        }
    }
    if run >= 5 {
        score += 3 + (run - 5);
    }
    score
}

/// Count non-overlapping... actually overlapping occurrences of `pat` in `data`
/// (the QR finder-penalty counts every position).
fn count_subslice(data: &[bool], pat: &[bool]) -> u32 {
    if data.len() < pat.len() {
        return 0;
    }
    let mut count = 0;
    for w in data.windows(pat.len()) {
        if w == pat {
            count += 1;
        }
    }
    count
}

/// The alignment-pattern centre coordinates for a version (ISO/IEC 18004 Annex
/// E). v1 has none; v2–10 use the published centre lists.
fn alignment_centres(version: usize) -> Vec<usize> {
    match version {
        1 => vec![],
        2 => vec![6, 18],
        3 => vec![6, 22],
        4 => vec![6, 26],
        5 => vec![6, 30],
        6 => vec![6, 34],
        7 => vec![6, 22, 38],
        8 => vec![6, 24, 42],
        9 => vec![6, 26, 46],
        10 => vec![6, 28, 50],
        _ => vec![],
    }
}

/// The BCH(15,5)-coded, mask-XORed 15-bit format information for a 5-bit format
/// value (ISO/IEC 18004 §8.9 / Annex C).
fn bch_format(format: u32) -> u32 {
    let mut d = format << 10;
    // Divide by the generator G(x) = 0b10100110111 (0x537), degree 10.
    let g = 0b10100110111u32;
    for i in (0..5).rev() {
        if (d >> (10 + i)) & 1 == 1 {
            d ^= g << i;
        }
    }
    let combined = (format << 10) | (d & 0x3FF);
    combined ^ 0b101010000010010 // mask 0x5412
}

/// The first (top-left) format-bit position for bit index `i` (0 = MSB / bit 14).
/// Per ISO/IEC 18004 §8.9 placement around the top-left finder.
fn format_pos_a(i: usize) -> (usize, usize) {
    // Bits 0..=5 run down column 8 (rows 0..=5), bit 6 at (8,7), bit 7 at (8,8),
    // bit 8 at (7,8), bits 9..=14 along row 8 (columns 5..=0). Timing modules
    // (row/col 6) are skipped in the reserved set, so we walk explicit positions.
    const ROW_COL8: [(usize, usize); 9] =
        [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8), (7, 8)];
    const ROW8: [(usize, usize); 6] = [(5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)];
    if i < 9 {
        ROW_COL8[i]
    } else {
        ROW8[i - 9]
    }
}

/// The second (top-right / bottom-left) format-bit position for bit index `i`.
fn format_pos_b(i: usize, n: usize) -> (usize, usize) {
    // Bits 0..=7 run leftward along row 8 from the right edge; bits 8..=14 run
    // upward along column 8 from the bottom edge.
    if i < 8 {
        (n - 1 - i, 8)
    } else {
        (8, n - 1 - (14 - i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_barcode_qr_gf256_round_trips() {
        let gf = Gf::new();
        // α^0 = 1; α^255 = α^0 = 1 (cyclic). exp/log are inverses.
        assert_eq!(gf.exp[0], 1);
        for a in 1u8..=255 {
            assert_eq!(gf.exp[gf.log[a as usize] as usize], a);
        }
        // Multiplication is GF(256): 2·2 = 4, and the primitive reduction works.
        assert_eq!(gf.mul(2, 2), 4);
        assert_eq!(gf.mul(0, 5), 0);
    }

    #[test]
    fn data_barcode_qr_reed_solomon_known_vector() {
        // The ISO/IEC 18004 Annex I worked example: the data codewords of a v1-M
        // QR encoding "01234567" produce a known EC block. We use the canonical
        // RS test from the spec: data [0x10,0x20,0x0C,0x56,0x61,0x80,0xEC,0x11,
        // 0xEC,0x11,0xEC,0x11,0xEC,0x11,0xEC,0x11] with 10 EC codewords yields a
        // specific remainder. We assert the EC length + determinism here and rely
        // on the structural matrix test for end-to-end correctness.
        let data: Vec<u8> = vec![0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
        let ec = reed_solomon(&data, 10);
        assert_eq!(ec.len(), 10);
        // Determinism: same input → same EC.
        assert_eq!(ec, reed_solomon(&data, 10));
        // The published v1-M EC for this block (Thonky/ISO worked example).
        assert_eq!(ec, vec![0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55]);
    }

    #[test]
    fn data_barcode_qr_bch_format_known_vector() {
        // ISO/IEC 18004 Annex C: format value 00101 (level M? — table) → a known
        // 15-bit string. Level M + mask 0 → format bits 00000, known result.
        // For (EC=M=00, mask=000) the spec's format string is 101010000010010.
        let bits = bch_format(0b00000);
        assert_eq!(bits, 0b101010000010010);
    }

    #[test]
    fn data_barcode_qr_version_selection_grows_with_payload() {
        // A short string fits v1.
        let (v1, _) = pick_version(5).unwrap();
        assert_eq!(v1, 1);
        // A ~20-byte payload exceeds v1-M (16 data codewords ≈ 14 usable bytes).
        let (v2, _) = pick_version(20).unwrap();
        assert!(v2 >= 2);
        // Oversized payload (past v10-M's 216 codewords) → a typed error.
        assert!(matches!(
            pick_version(10_000),
            Err(BarcodeError::TooLong { .. })
        ));
    }

    #[test]
    fn data_barcode_qr_matrix_has_finders_and_quiet_zone() {
        let g = encode_qr("https://paged.media").unwrap();
        // The matrix is square (modules_x == modules_y) incl. the quiet zone.
        assert_eq!(g.modules_x, g.modules_y);
        assert!(g.modules_x >= 21 + 2 * QUIET);
        // QR carries no HRI text line.
        assert!(g.text.is_empty());
        // There ARE dark modules, and they are 1×1 squares in the unit box.
        assert!(g.rect_count() > 0);
        let unit = 1.0 / g.modules_x as f64;
        assert!((g.rects[0].w - unit).abs() < 1e-9);
        assert!((g.rects[0].h - unit).abs() < 1e-9);
    }

    #[test]
    fn data_barcode_qr_finder_pattern_is_present_top_left() {
        // Re-encode and check the top-left finder is a solid 7×7 ring by counting
        // the dark modules in the quiet-zone-offset finder box.
        let size = 21; // v1
        let mut m = Matrix::new(size);
        m.place_function_patterns(1);
        // Finder corner (0,0): the centre 3×3 is dark, the ring is dark.
        assert!(m.dark[m.idx(0, 0)]); // top-left corner dark
        assert!(m.dark[m.idx(3, 3)]); // centre dark
        assert!(!m.dark[m.idx(1, 1)]); // inside the ring, light
    }

    #[test]
    fn data_barcode_qr_is_deterministic() {
        let a = encode_qr("SKU-99812").unwrap();
        let b = encode_qr("SKU-99812").unwrap();
        assert_eq!(a.rects, b.rects);
        assert_eq!(a.modules_x, b.modules_x);
    }
}
