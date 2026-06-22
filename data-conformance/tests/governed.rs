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

//! Governed-catalog conformance (spec §7): `paged.data` consumes a governed
//! dataset's *outputs* — the materialized table plus an optional column-metadata
//! sidecar — and presents a DOCUMENTED catalog (labels/descriptions/provenance)
//! over the live schema, surfacing governance drift rather than hiding it. The
//! engine-neutral half is exercised here at the session level: the bundle reads
//! the sidecar JSON; the engine enriches the query's resolved schema with it.

use data_conformance::{n, record_set, t};
use data_core::{FieldType, Query, QueryId, ResultShape};
use data_js::core::DataSession;
use data_sources::{CatalogDiagnostic, ColumnMetadata, DatasetMetadata};

fn session_with_result() -> DataSession {
    let mut s = DataSession::new(0);
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: "SELECT sku, price, secret FROM fct_products".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    s.ingest_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("sku", FieldType::Text),
                ("price", FieldType::Float),
                ("secret", FieldType::Text),
            ],
            vec![vec![t("a")], vec![n(9.99)], vec![t("x")]],
        ),
    );
    s
}

fn sidecar() -> DatasetMetadata {
    DatasetMetadata {
        dataset: Some("fct_products".into()),
        columns: vec![
            ColumnMetadata {
                name: "sku".into(),
                label: Some("SKU".into()),
                description: Some("Stock-keeping unit".into()),
                data_type: Some(FieldType::Text),
                provenance: Some("dim_products".into()),
            },
            ColumnMetadata {
                name: "price".into(),
                label: Some("List price".into()),
                description: None,
                data_type: Some(FieldType::Int), // documented Int, data is Float → drift
                provenance: None,
            },
            ColumnMetadata {
                name: "discount".into(), // documented but absent from the data → stale
                label: Some("Discount".into()),
                description: None,
                data_type: None,
                provenance: None,
            },
        ],
    }
}

#[test]
fn data_governed_catalog() {
    let s = session_with_result();
    let cat = s.governed_catalog(&QueryId::from("q1"), sidecar()).unwrap();

    // The documented catalog: live columns in schema order, the actual type, the
    // sidecar's label/provenance applied; the undocumented `secret` keeps its raw
    // name and is flagged undocumented.
    assert_eq!(cat.columns.len(), 3);
    assert_eq!(cat.columns[0].label, "SKU");
    assert_eq!(cat.columns[0].provenance.as_deref(), Some("dim_products"));
    assert!(cat.columns[0].documented);
    assert_eq!(cat.columns[1].data_type, FieldType::Float); // data is authoritative
    assert!(!cat.columns[2].documented);
    assert_eq!(cat.columns[2].label, "secret");

    // Governance drift is surfaced, not hidden: a type mismatch on `price`, an
    // undocumented `secret`, and a stale `discount`.
    assert!(cat.diagnostics.contains(&CatalogDiagnostic::TypeMismatch {
        name: "price".into(),
        documented: FieldType::Int,
        actual: FieldType::Float,
    }));
    assert!(cat
        .diagnostics
        .contains(&CatalogDiagnostic::UndocumentedColumn {
            name: "secret".into()
        }));
    assert!(cat.diagnostics.contains(&CatalogDiagnostic::MissingColumn {
        name: "discount".into()
    }));
}

#[test]
fn data_governed_catalog_no_result_errors() {
    // A catalog enriches a real schema — no ingested result is a typed error.
    let mut s = DataSession::new(0);
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    assert!(s
        .governed_catalog(&QueryId::from("q1"), DatasetMetadata::default())
        .is_err());
}
