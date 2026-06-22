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

//! Batch-plan conformance (spec §10): the "build" capability partitions a
//! resolved result into the deterministic sequence of generation units a batch
//! run produces — per-record flyers, per-group catalogs, or one paginated
//! catalog. The plan is computed at the session level (over an ingested result);
//! the executor lowers each unit through the normal pipeline (nothing renders
//! here). The plan-engine internals are also unit-tested in data-automation.

use data_automation::BatchMode;
use data_conformance::{n, record_set, t};
use data_core::{FieldType, Query, QueryId, ResultShape};
use data_js::core::DataSession;

fn session() -> DataSession {
    let mut s = DataSession::new(0);
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: "SELECT store, region, qty FROM sales".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    // Three records across two regions — ingested unordered.
    s.ingest_result(
        QueryId::from("q1"),
        record_set(
            &[
                ("store", FieldType::Text),
                ("region", FieldType::Text),
                ("qty", FieldType::Float),
            ],
            vec![
                vec![t("west-1"), t("east-1"), t("east-2")],
                vec![t("west"), t("east"), t("east")],
                vec![n(3.0), n(1.0), n(2.0)],
            ],
        ),
    );
    s
}

#[test]
fn data_automation_batch() {
    let s = session();

    // Per record → one unit each, labelled by `store` (stabilized order).
    let per_record = s
        .plan_batch(
            &QueryId::from("q1"),
            BatchMode::PerRecord {
                key: Some("store".into()),
            },
        )
        .unwrap();
    assert_eq!(per_record.mode, "perRecord");
    assert_eq!(per_record.units.len(), 3);
    assert_eq!(per_record.total_records, 3);
    // Stabilized by all columns → east-1, east-2, west-1.
    assert_eq!(per_record.units[0].label, "east-1");
    assert_eq!(per_record.units[2].label, "west-1");

    // Per group (by region) → one unit per region (first-seen, stabilized).
    let per_group = s
        .plan_batch(
            &QueryId::from("q1"),
            BatchMode::PerGroup {
                by: vec!["region".into()],
            },
        )
        .unwrap();
    assert_eq!(per_group.mode, "perGroup");
    assert_eq!(per_group.units.len(), 2);
    assert_eq!(per_group.units[0].label, "east");
    assert_eq!(per_group.units[0].record_indices.len(), 2);
    assert_eq!(per_group.units[1].label, "west");

    // One catalog → a single unit over every record.
    let one = s
        .plan_batch(&QueryId::from("q1"), BatchMode::OneCatalog)
        .unwrap();
    assert_eq!(one.mode, "oneCatalog");
    assert_eq!(one.units.len(), 1);
    assert_eq!(one.units[0].record_indices, vec![0, 1, 2]);
}

#[test]
fn data_automation_batch_no_result_errors() {
    // A plan partitions a real result — no ingested result is a typed error.
    let mut s = DataSession::new(0);
    s.define_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    assert!(s
        .plan_batch(&QueryId::from("q1"), BatchMode::OneCatalog)
        .is_err());
}
