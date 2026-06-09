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

//! The evaluation context (spec §9.1). `data-bind` implements [`RecordCtx`] over
//! a resolved record + the bound parameter set; [`SimpleCtx`] is a map-backed
//! impl for tests and simple call sites. The `today` serial is **injected**
//! (deterministic — `TODAY()` reads it, never the wall clock) so resolution is
//! reproducible (spec §12.4).

use std::collections::HashMap;

use data_core::Value;

/// The record + parameter view an expression evaluates against.
pub trait RecordCtx {
    /// A field of the current record by name (`None` if absent).
    fn field(&self, name: &str) -> Option<Value>;
    /// A bound query parameter by name (`None` if absent).
    fn param(&self, _name: &str) -> Option<Value> {
        None
    }
}

/// The evaluation context handed to every kernel.
pub struct EvalCtx<'a> {
    records: &'a dyn RecordCtx,
    /// Days since 1970-01-01 for `TODAY()` (injected, deterministic).
    today: i32,
}

impl<'a> EvalCtx<'a> {
    /// Build a context over a record view and an injected `today` serial.
    pub fn new(records: &'a dyn RecordCtx, today: i32) -> Self {
        EvalCtx { records, today }
    }

    /// Resolve a field of the current record.
    pub fn field(&self, name: &str) -> Option<Value> {
        self.records.field(name)
    }

    /// Resolve a bound parameter.
    pub fn param(&self, name: &str) -> Option<Value> {
        self.records.param(name)
    }

    /// The injected `today` serial (days since 1970-01-01).
    pub fn today(&self) -> i32 {
        self.today
    }
}

/// A map-backed [`RecordCtx`] for tests and simple call sites.
#[derive(Debug, Default, Clone)]
pub struct SimpleCtx {
    fields: HashMap<String, Value>,
    params: HashMap<String, Value>,
}

impl SimpleCtx {
    /// An empty context.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a field (builder style).
    pub fn with_field(mut self, name: &str, value: Value) -> Self {
        self.fields.insert(name.to_string(), value);
        self
    }

    /// Add a parameter (builder style).
    pub fn with_param(mut self, name: &str, value: Value) -> Self {
        self.params.insert(name.to_string(), value);
        self
    }
}

impl RecordCtx for SimpleCtx {
    fn field(&self, name: &str) -> Option<Value> {
        self.fields.get(name).cloned()
    }
    fn param(&self, name: &str) -> Option<Value> {
        self.params.get(name).cloned()
    }
}
