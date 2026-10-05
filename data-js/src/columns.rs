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

//! The typed column door (Wave 2): a query result crosses the wasm boundary
//! as one typed buffer per column — `Float64Array` numbers, `Int32Array`
//! days, one UTF-8 buffer + `Int32Array` offsets for text, an Arrow-layout
//! validity bitmap — instead of one serde-decoded `{t, v}` object per cell.
//! wasm-bindgen copies each buffer into wasm memory once; this module turns
//! the buffers into a [`RecordSet`].
//!
//! It also fingerprints the buffers as they arrive (a word-wise transport
//! hash), so a refresh that delivers the same result again is recognised
//! BEFORE a single `Value` is built: the session skips the build and the
//! ingest entirely and reports `Unchanged`.

use data_core::{QueryId, RecordSet, Schema, Value};

use crate::core::SessionError;

/// One column's buffers. `valid` is an Arrow-layout validity bitmap (bit `i`,
/// LSB first, set = present); `None` = every row present.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnBuf {
    /// Numbers (int / float / decimal) as f64.
    F64 {
        values: Vec<f64>,
        valid: Option<Vec<u8>>,
    },
    /// Booleans, one byte per row (0 / 1).
    Bool {
        values: Vec<u8>,
        valid: Option<Vec<u8>>,
    },
    /// Days since 1970-01-01.
    Date {
        values: Vec<i32>,
        valid: Option<Vec<u8>>,
    },
    /// Milliseconds since the epoch (UTC), as f64 (exact to 2^53 ms).
    DateTime {
        values: Vec<f64>,
        valid: Option<Vec<u8>>,
    },
    /// Text: one UTF-8 buffer, `offsets` has `rows + 1` entries.
    Utf8 {
        bytes: Vec<u8>,
        offsets: Vec<i32>,
        valid: Option<Vec<u8>>,
    },
    /// Binary: as `Utf8`, the bytes uninterpreted.
    Binary {
        bytes: Vec<u8>,
        offsets: Vec<i32>,
        valid: Option<Vec<u8>>,
    },
}

/// Whether an ingest changed the engine's result for the query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestOutcome {
    /// New content: decoded and delivered to the engine.
    Changed,
    /// The same buffers as the last column ingest for this query: nothing was
    /// decoded or delivered.
    Unchanged,
}

impl IngestOutcome {
    /// `"changed"` / `"unchanged"` — the string that crosses the boundary.
    pub fn as_str(self) -> &'static str {
        match self {
            IngestOutcome::Changed => "changed",
            IngestOutcome::Unchanged => "unchanged",
        }
    }
}

/// A word-wise transport hash (FNV-style mixing over 8-byte words). It only
/// recognises a re-delivery of identical buffers; the engine's own content
/// hash (`data_query::content_hash`) stays the identity of the data.
#[derive(Debug, Clone, Copy)]
struct WordHash(u64);

impl WordHash {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    fn new() -> Self {
        WordHash(0xcbf2_9ce4_8422_2325)
    }
    fn word(&mut self, w: u64) {
        self.0 = (self.0 ^ w).wrapping_mul(Self::PRIME).rotate_left(29);
    }
    fn bytes(&mut self, b: &[u8]) {
        let mut chunks = b.chunks_exact(8);
        for c in &mut chunks {
            self.word(u64::from_le_bytes(c.try_into().expect("8 bytes")));
        }
        let rest = chunks.remainder();
        let mut last = [0u8; 8];
        last[..rest.len()].copy_from_slice(rest);
        self.word(u64::from_le_bytes(last) ^ ((rest.len() as u64) << 56));
        self.word(b.len() as u64);
    }
}

/// A column ingest in progress: `begin` → one `push` per schema field →
/// `finish`.
#[derive(Debug)]
pub struct ColumnIngest {
    query: QueryId,
    schema: Schema,
    rows: usize,
    columns: Vec<ColumnBuf>,
    hash: WordHash,
}

fn decode_err(msg: String) -> SessionError {
    SessionError::Decode(msg)
}

impl ColumnIngest {
    /// Start an ingest of `rows` rows under `schema`.
    pub fn begin(query: QueryId, schema: Schema, rows: usize) -> Self {
        let mut hash = WordHash::new();
        for f in &schema.fields {
            hash.bytes(f.name.as_bytes());
            hash.bytes(format!("{:?} {:?}", f.ty, f.scale).as_bytes());
        }
        hash.word(rows as u64);
        ColumnIngest {
            query,
            schema,
            rows,
            columns: Vec::new(),
            hash,
        }
    }

    /// The query this ingest delivers.
    pub fn query(&self) -> &QueryId {
        &self.query
    }

    /// Add the next column, checking its buffers against the row count.
    pub fn push(&mut self, col: ColumnBuf) -> Result<(), SessionError> {
        let i = self.columns.len();
        let Some(field) = self.schema.fields.get(i) else {
            return Err(decode_err(format!(
                "column {i} pushed, but the schema has {} fields",
                self.schema.fields.len()
            )));
        };
        let n = self.rows;
        let check = |len: usize, what: &str| {
            if len == n {
                Ok(())
            } else {
                Err(decode_err(format!(
                    "column '{}': {len} {what} for {n} rows",
                    field.name
                )))
            }
        };
        let (tag, valid) = match &col {
            ColumnBuf::F64 { values, valid } => {
                check(values.len(), "values")?;
                values.iter().for_each(|v| self.hash.word(v.to_bits()));
                (1u64, valid)
            }
            ColumnBuf::Bool { values, valid } => {
                check(values.len(), "values")?;
                self.hash.bytes(values);
                (2, valid)
            }
            ColumnBuf::Date { values, valid } => {
                check(values.len(), "values")?;
                values.iter().for_each(|v| self.hash.word(*v as u32 as u64));
                (3, valid)
            }
            ColumnBuf::DateTime { values, valid } => {
                check(values.len(), "values")?;
                values.iter().for_each(|v| self.hash.word(v.to_bits()));
                (4, valid)
            }
            ColumnBuf::Utf8 {
                bytes,
                offsets,
                valid,
            }
            | ColumnBuf::Binary {
                bytes,
                offsets,
                valid,
            } => {
                if offsets.len() != n + 1 {
                    return Err(decode_err(format!(
                        "column '{}': {} offsets for {n} rows",
                        field.name,
                        offsets.len()
                    )));
                }
                let bad = offsets.first() != Some(&0)
                    || offsets.windows(2).any(|w| w[1] < w[0])
                    || offsets[n] as usize > bytes.len();
                if bad {
                    return Err(decode_err(format!(
                        "column '{}': offsets out of order or past the buffer",
                        field.name
                    )));
                }
                self.hash.bytes(bytes);
                offsets
                    .iter()
                    .for_each(|o| self.hash.word(*o as u32 as u64));
                (
                    if matches!(col, ColumnBuf::Utf8 { .. }) {
                        5
                    } else {
                        6
                    },
                    valid,
                )
            }
        };
        if let Some(v) = valid {
            if v.len() < n.div_ceil(8) {
                return Err(decode_err(format!(
                    "column '{}': validity bitmap of {} bytes for {n} rows",
                    field.name,
                    v.len()
                )));
            }
            // Hash only the bits that name rows.
            for (r, chunk) in v[..n.div_ceil(8)].iter().enumerate() {
                let bits = if (r + 1) * 8 > n {
                    chunk & ((1u16 << (n - r * 8)) - 1) as u8
                } else {
                    *chunk
                };
                self.hash.word(0x100 | bits as u64);
            }
        }
        self.hash.word(tag);
        self.columns.push(col);
        Ok(())
    }

    /// The transport hash, once every column has been pushed.
    pub fn transport_hash(&self) -> Result<u64, SessionError> {
        if self.columns.len() != self.schema.fields.len() {
            return Err(decode_err(format!(
                "{} of {} columns pushed",
                self.columns.len(),
                self.schema.fields.len()
            )));
        }
        Ok(self.hash.0)
    }

    /// Build the record set (every column pushed).
    pub fn into_record_set(self) -> Result<RecordSet, SessionError> {
        self.transport_hash()?;
        let n = self.rows;
        let present = |valid: &Option<Vec<u8>>, i: usize| match valid {
            None => true,
            Some(v) => (v[i >> 3] >> (i & 7)) & 1 == 1,
        };
        let columns: Vec<Vec<Value>> = self
            .columns
            .into_iter()
            .map(|col| match col {
                ColumnBuf::F64 { values, valid } => (0..n)
                    .map(|i| {
                        if present(&valid, i) {
                            Value::Number(values[i])
                        } else {
                            Value::Null
                        }
                    })
                    .collect(),
                ColumnBuf::Bool { values, valid } => (0..n)
                    .map(|i| {
                        if present(&valid, i) {
                            Value::Bool(values[i] != 0)
                        } else {
                            Value::Null
                        }
                    })
                    .collect(),
                ColumnBuf::Date { values, valid } => (0..n)
                    .map(|i| {
                        if present(&valid, i) {
                            Value::Date(values[i])
                        } else {
                            Value::Null
                        }
                    })
                    .collect(),
                ColumnBuf::DateTime { values, valid } => (0..n)
                    .map(|i| {
                        if present(&valid, i) {
                            Value::DateTime(values[i] as i64)
                        } else {
                            Value::Null
                        }
                    })
                    .collect(),
                ColumnBuf::Utf8 {
                    bytes,
                    offsets,
                    valid,
                } => (0..n)
                    .map(|i| {
                        if !present(&valid, i) {
                            return Value::Null;
                        }
                        let b = &bytes[offsets[i] as usize..offsets[i + 1] as usize];
                        match std::str::from_utf8(b) {
                            Ok(s) => Value::text(s),
                            Err(_) => Value::text(String::from_utf8_lossy(b).as_ref()),
                        }
                    })
                    .collect(),
                ColumnBuf::Binary {
                    bytes,
                    offsets,
                    valid,
                } => (0..n)
                    .map(|i| {
                        if !present(&valid, i) {
                            return Value::Null;
                        }
                        Value::Bytes(bytes[offsets[i] as usize..offsets[i + 1] as usize].to_vec())
                    })
                    .collect(),
            })
            .collect();
        RecordSet::new(self.schema, columns).map_err(|e| decode_err(e.to_string()))
    }
}
