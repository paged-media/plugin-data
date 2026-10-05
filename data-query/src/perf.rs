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

//! Work counters for the perf budgets (campaign Wave 1).
//!
//! A budget is a COUNT, not a duration: the number of resolves a refresh
//! costs, the sort keys `stabilize` allocates, the cells an ingest carries.
//! A count is the same on a laptop and a CI runner, and a fix that halves it
//! halves it everywhere.
//!
//! The counters live here because `data-query` is the lowest crate the
//! counted paths share (`data-bind` depends on it). They are compiled in only
//! under the `perf-counters` feature; without it [`bump`] is an empty
//! `#[inline(always)]` function and the counters do not exist, so the
//! default build pays nothing.
//!
//! Thread-local on purpose: the wasm engine is single-threaded, and a native
//! test that resets and reads its own thread's counters is not disturbed by a
//! test running beside it on another thread.

/// One counted kind of work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counter {
    /// A binding resolved to content (`Engine::resolve_content`), however it
    /// was reached: a resolve, a preview step, a fingerprint.
    Resolves = 0,
    /// A record set stabilized (`stabilize` — sort + reorder copy).
    StabilizeCalls,
    /// A sort key built by `value_key` — each one is a fresh `Vec<u8>`; the
    /// comparator builds two per column it compares.
    KeyAllocs,
    /// A resolved binding fingerprinted for the change report.
    Fingerprints,
    /// A row visited by the record-identity `diff` (old rows + new rows).
    DiffRows,
    /// A cell delivered into the engine by `set_result` (rows × columns).
    IngestCells,
    /// A full-content hash of a record set (`content_hash`).
    ContentHashes,
    /// A group-key comparison in `group_by` (the O(n·g) linear scan).
    GroupKeyCompares,
}

/// How many counters there are (the array length).
pub const COUNTERS: usize = 8;

/// A snapshot of every counter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PerfCounters {
    pub resolves: u64,
    pub stabilize_calls: u64,
    pub key_allocs: u64,
    pub fingerprints: u64,
    pub diff_rows: u64,
    pub ingest_cells: u64,
    pub content_hashes: u64,
    pub group_key_compares: u64,
}

#[cfg(feature = "perf-counters")]
mod imp {
    use super::{Counter, PerfCounters, COUNTERS};
    use std::cell::Cell;

    thread_local! {
        static COUNTS: [Cell<u64>; COUNTERS] = const { [const { Cell::new(0) }; COUNTERS] };
    }

    #[inline(always)]
    pub fn bump(c: Counter) {
        add(c, 1);
    }

    #[inline(always)]
    pub fn add(c: Counter, n: u64) {
        COUNTS.with(|a| {
            let cell = &a[c as usize];
            cell.set(cell.get().wrapping_add(n));
        });
    }

    pub fn snapshot() -> PerfCounters {
        COUNTS.with(|a| PerfCounters {
            resolves: a[Counter::Resolves as usize].get(),
            stabilize_calls: a[Counter::StabilizeCalls as usize].get(),
            key_allocs: a[Counter::KeyAllocs as usize].get(),
            fingerprints: a[Counter::Fingerprints as usize].get(),
            diff_rows: a[Counter::DiffRows as usize].get(),
            ingest_cells: a[Counter::IngestCells as usize].get(),
            content_hashes: a[Counter::ContentHashes as usize].get(),
            group_key_compares: a[Counter::GroupKeyCompares as usize].get(),
        })
    }

    pub fn reset() {
        COUNTS.with(|a| a.iter().for_each(|c| c.set(0)));
    }
}

#[cfg(not(feature = "perf-counters"))]
mod imp {
    use super::{Counter, PerfCounters};

    #[inline(always)]
    pub fn bump(_: Counter) {}

    #[inline(always)]
    pub fn add(_: Counter, _: u64) {}

    pub fn snapshot() -> PerfCounters {
        PerfCounters::default()
    }

    pub fn reset() {}
}

/// Count one unit of `c` (a no-op without `perf-counters`).
#[inline(always)]
pub fn bump(c: Counter) {
    imp::bump(c);
}

/// Count `n` units of `c` (a no-op without `perf-counters`).
#[inline(always)]
pub fn add(c: Counter, n: u64) {
    imp::add(c, n);
}

/// The counters as they stand on this thread (all zero without the feature).
pub fn snapshot() -> PerfCounters {
    imp::snapshot()
}

/// Zero this thread's counters (a no-op without the feature).
pub fn reset() {
    imp::reset();
}

/// Whether this build counts at all.
pub const ENABLED: bool = cfg!(feature = "perf-counters");
