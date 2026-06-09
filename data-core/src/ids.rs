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

//! Stable string identities (spec §5). Source / query / binding / placeholder
//! ids are author-assigned and travel in the document payload; the `*Ref`
//! newtypes point at host elements (frames, frame chains, scopes, templates)
//! by their document element id. All are ordered + hashable so the resolution
//! graph and the sync diff can key on them deterministically.

use compact_str::CompactString;
use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(
            Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        pub struct $name(pub CompactString);

        impl $name {
            /// Construct from anything string-like.
            pub fn new(s: impl Into<CompactString>) -> Self {
                Self(s.into())
            }
            /// Borrow the underlying string.
            pub fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0.as_str())
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(CompactString::new(s))
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(CompactString::from(s))
            }
        }
    };
}

id_newtype!(
    /// A data source (a connection + its scope, spec §5.1).
    SourceId
);
id_newtype!(
    /// A named, parameterized query over sources (spec §5.1).
    QueryId
);
id_newtype!(
    /// A binding definition (spec §5.1) — the document-scoped payload key.
    BindingId
);
id_newtype!(
    /// A named, edit-surviving placeholder anchor in document content (§5.2).
    PlaceholderRef
);
id_newtype!(
    /// Which granted capability authorizes a source (§11 capability gating).
    CapabilityRef
);
id_newtype!(
    /// A host frame element (table/flow region target).
    FrameRef
);
id_newtype!(
    /// A host frame-chain (record flow across threaded frames, §9.4).
    FrameChainRef
);
id_newtype!(
    /// A styling scope for a data-driven formatting rule (§9.5).
    ScopeRef
);
id_newtype!(
    /// A designed per-record template (the "catalog cell", §9.4).
    TemplateRef
);
