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

//! # data-automation — print automation / batch generation (spec §10)
//!
//! **RESERVED skeleton — the T2 (M2) crate.** Present-but-reserved, the way
//! `sheet-grid`/`sheet-chart` are reserved in plugin-sheets: the workspace
//! member + the milestone marker exist so the §4 crate architecture is whole,
//! but the batch/headless generation surface is **not implemented at M0**. Its
//! registry rows ride as `status: planned` (no coverage-gate obligation).
//!
//! M2 scope (spec §10, D-7): parameterized multi-document/multi-section
//! generation from a single template document; the constrained Boa scripting
//! surface for queries/builds. Pipelines/scheduling/webhooks are out — that is
//! the user's automation platform calling the napi-rs binding.

/// The milestone this crate ships in (so the reserved-but-present status is
/// machine-checkable and the crate is non-empty).
pub const MILESTONE: &str = "T2 (M2) — batch/headless generation; spec §10.";

/// The execution modes the M2 surface will expose (declared now, dispatched
/// at M2). Reserved — constructing a value is a no-op marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// The document is bound and regenerates live as data changes (the default).
    Interactive,
    /// Generate many outputs from data (per-record / per-group / one catalog),
    /// natively (napi-rs) or in-app.
    Batch,
}
