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

//! Image-placeholder conformance (spec §9.2): the field value classifies into a
//! reference (uri / path / asset id / bytes); the missing policy decides the
//! status when absent; lowering packages the placement IR. The image is placed
//! through the core asset mechanism — never `plugin-image` (§2.1). (The host
//! placement op is an SDK gap, D-14 — the engine resolves + lowers regardless.)

use data_bind::{ResolutionEngine, Resolved};
use data_conformance::{record_set, t, today};
use data_core::{
    Binding, BindingId, FieldType, ImageReference, ImageStatus, ImgFit, ImgMissing, ImgPolicy,
    PlaceholderRef, Query, QueryId, ResultShape,
};
use data_lower::lower_image;

fn image_binding(expr: &str, missing: ImgMissing) -> Binding {
    Binding::Image {
        target: PlaceholderRef::from("img-ph"),
        query: QueryId::from("q1"),
        expr: expr.into(),
        policy: ImgPolicy {
            fit: ImgFit::Crop,
            missing,
        },
    }
}

fn engine_with(field: &str, value: &str) -> ResolutionEngine {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q1"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::SingleRecord,
    });
    e.set_result(
        QueryId::from("q1"),
        record_set(&[(field, FieldType::Text)], vec![vec![t(value)]]),
    );
    e
}

#[test]
fn data_bind_image_classifies() {
    for (value, expected) in [
        (
            "https://cdn.test/a.png",
            ImageReference::Uri {
                uri: "https://cdn.test/a.png".into(),
            },
        ),
        (
            "photos/a.jpg",
            ImageReference::Path {
                path: "photos/a.jpg".into(),
            },
        ),
        ("asset:xyz", ImageReference::AssetId { id: "xyz".into() }),
    ] {
        let mut e = engine_with("img", value);
        e.add_binding(BindingId::from("b"), image_binding("img", ImgMissing::Skip));
        match e.resolve(&BindingId::from("b")).unwrap() {
            Resolved::Image(img) => {
                assert_eq!(img.reference, expected);
                assert_eq!(img.status, ImageStatus::Present);
                assert_eq!(img.fit, ImgFit::Crop);
            }
            other => panic!("expected image, got {other:?}"),
        }
    }
}

#[test]
fn data_bind_image_missing_policy() {
    for (missing, status) in [
        (ImgMissing::Skip, ImageStatus::Skipped),
        (ImgMissing::Flag, ImageStatus::Flagged),
        (ImgMissing::Fallback, ImageStatus::Fallback),
    ] {
        let mut e = engine_with("img", ""); // empty → missing
        e.add_binding(BindingId::from("b"), image_binding("img", missing));
        match e.resolve(&BindingId::from("b")).unwrap() {
            Resolved::Image(img) => {
                assert_eq!(img.reference, ImageReference::None);
                assert_eq!(img.status, status);
            }
            other => panic!("expected image, got {other:?}"),
        }
    }
}

#[test]
fn data_lower_image_packages_ir() {
    let lowered = lower_image(
        PlaceholderRef::from("img-ph"),
        ImageReference::Uri {
            uri: "https://cdn.test/a.png".into(),
        },
        ImgFit::Fill,
        ImageStatus::Present,
    );
    assert_eq!(lowered.target, PlaceholderRef::from("img-ph"));
    assert_eq!(lowered.fit, ImgFit::Fill);
    assert_eq!(lowered.status, ImageStatus::Present);
    assert!(matches!(lowered.reference, ImageReference::Uri { .. }));
}
