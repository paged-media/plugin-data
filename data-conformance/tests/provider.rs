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

//! Data-provider publication conformance (spec §7.1): `paged.data` exposes a
//! query's resolved result as a named, discoverable dataset for OTHER consumers
//! (most importantly the sheets plugin) through the core SDK data-provider
//! registry — declaring the provider, never knowing who consumes it. The engine
//! side here produces the publication payload: a schema + the **stabilized**
//! RecordSet + an opaque content-revision etag. Registration with the core
//! registry is the D-09 gate; this proves the payload is correct, deterministic,
//! and identity-stable (the precondition for the §7.1 refresh signal).

use data_conformance::{n, record_set, t};
use data_core::{FieldType, Query, QueryId, ResultShape};
use data_js::core::DataSession;

fn query(id: &str) -> Query {
    Query {
        id: QueryId::from(id),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    }
}

#[test]
fn data_provider_publish() {
    let mut s = DataSession::new(0);
    s.define_query(query("q1"));
    // Ingest out of natural order (sku b,a,c) — DuckDB iteration is unordered.
    s.ingest_result(
        QueryId::from("q1"),
        record_set(
            &[("sku", FieldType::Text), ("price", FieldType::Float)],
            vec![vec![t("b"), t("a"), t("c")], vec![n(2.0), n(1.0), n(3.0)]],
        ),
    );

    let p = s
        .publish_provider(&QueryId::from("q1"), "pricing-dataset", "dataset")
        .unwrap();

    // Discovery descriptor: a stable id + a neutral category (consumers find
    // providers by category, never by plugin identity, §7.1).
    assert_eq!(p.id, "pricing-dataset");
    assert_eq!(p.category, "dataset");

    // The schema descriptor is the published columns (the half `discover`
    // surfaces without shipping the rows).
    assert_eq!(p.row_count, 3);
    assert_eq!(p.schema.fields.len(), 2);
    assert_eq!(p.schema.fields[0].name, "sku");
    assert_eq!(p.schema.fields[1].ty, FieldType::Float);

    // The snapshot is STABILIZED to a deterministic order (sku a,b,c) regardless
    // of the unordered ingest — the §7.1 identity-stable snapshot a consumer can
    // diff against its last pull.
    assert_eq!(p.records.value(0, 0), Some(&t("a")));
    assert_eq!(p.records.value(1, 0), Some(&t("b")));
    assert_eq!(p.records.value(2, 0), Some(&t("c")));
    assert_eq!(p.records.value(0, 1), Some(&n(1.0)));

    // The revision is an opaque, non-empty content etag.
    assert!(!p.revision.is_empty());
}

#[test]
fn data_provider_publish_revision_is_permutation_invariant() {
    // The refresh token tracks the DATA, not DuckDB's iteration order: the same
    // rows ingested in a different order publish the SAME revision, so a consumer
    // does not re-pull on a meaningless reorder (§6.1 stabilize / §7.1 sync).
    let mut a = DataSession::new(0);
    let mut b = DataSession::new(0);
    a.define_query(query("q"));
    b.define_query(query("q"));
    a.ingest_result(
        QueryId::from("q"),
        record_set(
            &[("k", FieldType::Text)],
            vec![vec![t("x"), t("y"), t("z")]],
        ),
    );
    b.ingest_result(
        QueryId::from("q"),
        record_set(
            &[("k", FieldType::Text)],
            vec![vec![t("z"), t("x"), t("y")]],
        ),
    );
    let pa = a
        .publish_provider(&QueryId::from("q"), "p", "dataset")
        .unwrap();
    let pb = b
        .publish_provider(&QueryId::from("q"), "p", "dataset")
        .unwrap();
    assert_eq!(pa.revision, pb.revision);

    // A genuine data change DOES move the revision (the consumer re-pulls).
    let mut c = DataSession::new(0);
    c.define_query(query("q"));
    c.ingest_result(
        QueryId::from("q"),
        record_set(
            &[("k", FieldType::Text)],
            vec![vec![t("x"), t("y"), t("Q")]],
        ),
    );
    let pc = c
        .publish_provider(&QueryId::from("q"), "p", "dataset")
        .unwrap();
    assert_ne!(pa.revision, pc.revision);
}

#[test]
fn data_provider_publish_no_result_errors() {
    // Publishing a query with no ingested result is a typed error — the provider
    // exposes resolved data, never an empty promise (§7.1).
    let mut s = DataSession::new(0);
    s.define_query(query("q1"));
    assert!(s
        .publish_provider(&QueryId::from("q1"), "p", "dataset")
        .is_err());
}
