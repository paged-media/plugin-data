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

//! The source / query / result model (spec §5.1, §6). [`DataSource`] is a
//! connection + scope; [`Query`] is a named, parameterized SQL query;
//! [`RecordSet`] is the materialized, **Arrow-aligned** columnar result the
//! query engine produces (DuckDB-WASM → Arrow → `RecordSet`, the swappable
//! seam, §6.1). The engine stores results columnar (Arrow's shape) and
//! addresses rows by index — the basis for stable record identity in the sync
//! diff (§8).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ids::{CapabilityRef, QueryId, SourceId};
use crate::value::Value;

/// A connection + its scope (spec §5.1). The `capability` names which granted
/// capability authorizes it; a source cannot be created without the granting
/// capability present and consented (§6.2, §11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataSource {
    pub id: SourceId,
    pub kind: SourceKind,
    pub capability: CapabilityRef,
    #[serde(default)]
    pub refresh: RefreshPolicy,
}

/// The source kinds (spec §6.2). M0 implements `InlineSeed` + `File` *models*;
/// the byte IO for File/Remote/DbAttach/GovernedExtract is performed by
/// DuckDB-WASM in the bundle realm. Remote/DbAttach/GovernedExtract are
/// constructible-but-capability-gated and unreachable at M0 (`network:false`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceKind {
    /// A local file imported as bytes (CSV/TSV/JSON/Parquet/Excel), read by
    /// DuckDB over the imported bytes. Capability: `file-import` (D-04).
    File { format: FileFormat, name: String },
    /// An HTTP(S) file or REST/JSON API (CSV/JSON/Parquet over HTTP), described
    /// by `{url, format, params}`. Capability: `network` + per-origin consent
    /// (D-03). The descriptor is TRANSPORT-AGNOSTIC: the engine never fetches —
    /// the bundle supplies bytes after consent, exactly like the file adapter
    /// (M1; versioned amendment of the M0 `Remote { url }` shape — the added
    /// fields default, so M0 payloads still decode). Carries NO credential
    /// material: `credential_ref` names a host-store secret (D-11,
    /// rfc-credential-store), never the secret itself.
    Remote {
        url: String,
        /// The payload format DuckDB will read; `None` = infer from the URL.
        #[serde(default)]
        format: Option<FileFormat>,
        /// Extra request/query parameters (deterministically ordered).
        #[serde(default)]
        params: BTreeMap<String, String>,
        /// A reference into the host credential store (D-11) — a ref string
        /// only; secret bytes never enter the descriptor or the payload.
        #[serde(default)]
        credential_ref: Option<String>,
    },
    /// An attached SQLite/Postgres/MySQL database (DuckDB `ATTACH`).
    /// Capability: `network` + credential handling (D-03/D-11). The shape is
    /// DELIBERATELY CREDENTIAL-FREE: `db` is the engine, `target` is the
    /// non-secret locator (a file/OPFS name for SQLite, or `host:port/db`
    /// for Postgres/MySQL — never `user:pass@`), and `credential_ref` names
    /// a host-store secret (D-11, rfc-credential-store) the HOST resolves +
    /// injects on its side of the attach; the secret never enters the
    /// descriptor or the payload. The legacy `dsn` field is retained,
    /// optional + deprecated, so an M0/pre-D-11 payload still decodes — it
    /// is REDACTED to host-only on save (the user:pass@ is stripped); new
    /// sources leave it `None` and carry `credential_ref` instead.
    ///
    /// Transport scoping (honest): SQLite attach (file/OPFS-backed) is
    /// reachable in the pure-web tier; Postgres/MySQL over raw TCP is NOT
    /// browser-reachable — the source kind + the credential indirection +
    /// the host-injection seam exist for all three, but the actual
    /// Postgres/MySQL transport is the headless/napi + proxy lane (a named
    /// deferral, like interactive), never a fake in-browser TCP.
    DbAttach {
        /// The database engine to attach (drives the DuckDB attach idiom).
        db: DbEngine,
        /// The non-secret locator: a file/OPFS name (SQLite) or
        /// `host:port/dbname` (Postgres/MySQL) — NEVER carries credentials.
        target: String,
        /// A reference into the host credential store (D-11) — a ref string
        /// only (e.g. `keychain:source-4`); the host resolves + injects the
        /// live connection. `None` for an unauthenticated SQLite file.
        #[serde(default)]
        credential_ref: Option<String>,
        /// DEPRECATED M0 connection-string field, retained so a pre-D-11
        /// payload still decodes. Redacted to host-only on save (never
        /// carries a secret into a document). New sources leave it `None`.
        #[serde(default)]
        dsn: Option<String>,
    },
    /// A governed warehouse/database table + optional column-metadata sidecar
    /// (§7). Read via the file/DB/remote adapter. M2.
    GovernedExtract {
        location: String,
        #[serde(default)]
        metadata_sidecar: Option<String>,
    },
    /// Data embedded in the document (small lookup tables) — travels with the
    /// doc, needs no capability (§6.2). Available at M0.
    InlineSeed { table: String },
}

/// File formats DuckDB reads directly (spec §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Csv,
    Tsv,
    Json,
    Parquet,
    Excel,
}

/// Database engines a [`SourceKind::DbAttach`] can attach via DuckDB (D-11).
/// `Sqlite` (file/OPFS-backed) is reachable in the pure-web tier; `Postgres`
/// / `Mysql` over raw TCP are NOT browser-reachable — their transport is the
/// headless/napi + proxy lane (the descriptor + credential indirection + the
/// host-injection seam exist for all three; only the live transport differs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Sqlite,
    Postgres,
    Mysql,
}

impl DbEngine {
    /// Whether this engine's transport is reachable in the pure-web tier
    /// (SQLite yes — file/OPFS; Postgres/MySQL no — raw TCP, headless/proxy
    /// lane only). The descriptor is constructible for all three regardless;
    /// this gates only the LIVE attach transport (the honest scoping seam).
    pub fn reachable_in_browser(self) -> bool {
        matches!(self, DbEngine::Sqlite)
    }
}

/// When a source re-resolves (spec §5.1). Default is `Manual` (the safe,
/// non-surprising publishing default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "policy", rename_all = "camelCase")]
pub enum RefreshPolicy {
    #[default]
    Manual,
    OnOpen,
    /// Re-resolve every N seconds.
    Interval {
        secs: u64,
    },
    /// A frozen snapshot — never re-resolves (the document carries the data).
    Never,
}

/// A typed query parameter declaration (bound at resolve time, §5.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParamDecl {
    pub name: String,
    pub ty: ParamType,
    #[serde(default)]
    pub required: bool,
}

/// The type of a query parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    Text,
    Number,
    Bool,
    Date,
}

/// The shape a query result takes (spec §5.1, §6). Drives how `data-query`
/// reshapes a raw [`RecordSet`] and how bindings consume it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum ResultShape {
    /// Many records (the default — tables, record flow).
    RecordStream,
    /// Exactly one record (variable binding over a singleton query).
    SingleRecord,
    /// One scalar value (single field of a single record).
    Scalar,
    /// Grouped sections with header fields (catalog sectioning, §9.4).
    Grouped { by: Vec<String> },
}

/// A named, parameterized SQL query over sources (spec §5.1). The SQL is
/// DuckDB SQL; it references sources as tables/views. Parameters are typed and
/// bound at resolve time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Query {
    pub id: QueryId,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<ParamDecl>,
    pub shape: ResultShape,
}

/// One field of a result schema (spec §5.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub ty: FieldType,
    #[serde(default = "default_true")]
    pub nullable: bool,
}

fn default_true() -> bool {
    true
}

/// The logical type of a result field (the Arrow-aligned type vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Bool,
    Int,
    Float,
    Text,
    Date,
    DateTime,
    Bytes,
    Null,
}

/// The formatting locale for the display kernels (spec §9.1; v1 = en/de minimum,
/// mirroring plugin-sheet's D-8). It affects ONLY the `data-expr` format
/// functions' display output (`NUMBER`/`CURRENCY`/`PERCENT`/`DATEFMT`
/// separators, default currency symbol/placement, default date pattern). The
/// CANONICAL value form stays locale-free — re-resolution is idempotent
/// (`value.rs`), and content hashing never sees a locale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    /// English: `1,234.56`, `$` leading, `YYYY-MM-DD`.
    #[default]
    En,
    /// German: `1.234,56`, `€` trailing, `DD.MM.YYYY`.
    De,
}

impl Locale {
    /// The decimal separator.
    pub fn decimal_sep(self) -> char {
        match self {
            Locale::En => '.',
            Locale::De => ',',
        }
    }
    /// The thousands-grouping separator.
    pub fn group_sep(self) -> char {
        match self {
            Locale::En => ',',
            Locale::De => '.',
        }
    }
    /// The default currency symbol + whether it TRAILS the amount
    /// (`("€", true)` → `1.234,56 €`).
    pub fn currency(self) -> (&'static str, bool) {
        match self {
            Locale::En => ("$", false),
            Locale::De => ("€", true),
        }
    }
    /// The default `DATEFMT` pattern when the caller supplies none.
    pub fn date_pattern(self) -> &'static str {
        match self {
            Locale::En => "YYYY-MM-DD",
            Locale::De => "DD.MM.YYYY",
        }
    }
}

/// A result schema: field names + types, in column order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Schema {
    pub fields: Vec<Field>,
}

impl Schema {
    /// Build a schema from `(name, type)` pairs (all nullable).
    pub fn from_fields(fields: impl IntoIterator<Item = (String, FieldType)>) -> Self {
        Schema {
            fields: fields
                .into_iter()
                .map(|(name, ty)| Field {
                    name,
                    ty,
                    nullable: true,
                })
                .collect(),
        }
    }

    /// Column index of a field by (exact) name.
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|f| f.name == name)
    }
}

/// A materialized result (spec §5.1). Stored **columnar** (Arrow's shape):
/// `columns[c]` holds `row_count` values for `schema.fields[c]`. Rows are
/// addressed by index; record identity for the sync diff is a declared key or
/// the (deterministically ordered) row index (§8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordSet {
    pub schema: Schema,
    pub columns: Vec<Vec<Value>>,
    pub row_count: usize,
}

/// A malformed [`RecordSet`] (column/row mismatch) — a construction-time
/// invariant, surfaced rather than panicking.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RecordError {
    #[error("record set has {schema} schema fields but {columns} columns")]
    ColumnCount { schema: usize, columns: usize },
    #[error("column {index} has {len} values but row_count is {row_count}")]
    RowCount {
        index: usize,
        len: usize,
        row_count: usize,
    },
}

impl RecordSet {
    /// An empty result with the given schema.
    pub fn empty(schema: Schema) -> Self {
        let columns = vec![Vec::new(); schema.fields.len()];
        RecordSet {
            schema,
            columns,
            row_count: 0,
        }
    }

    /// Construct from columnar data, validating the column/row invariant.
    pub fn new(schema: Schema, columns: Vec<Vec<Value>>) -> Result<Self, RecordError> {
        if schema.fields.len() != columns.len() {
            return Err(RecordError::ColumnCount {
                schema: schema.fields.len(),
                columns: columns.len(),
            });
        }
        let row_count = columns.first().map(Vec::len).unwrap_or(0);
        for (index, col) in columns.iter().enumerate() {
            if col.len() != row_count {
                return Err(RecordError::RowCount {
                    index,
                    len: col.len(),
                    row_count,
                });
            }
        }
        Ok(RecordSet {
            schema,
            columns,
            row_count,
        })
    }

    /// The value at `(row, col)`, or `None` if out of bounds.
    pub fn value(&self, row: usize, col: usize) -> Option<&Value> {
        self.columns.get(col).and_then(|c| c.get(row))
    }

    /// The value of a named field in `row`, or `None` if the field/row is
    /// absent (the resolver maps that to a missing-value policy).
    pub fn field(&self, row: usize, name: &str) -> Option<&Value> {
        let col = self.schema.index_of(name)?;
        self.value(row, col)
    }
}
