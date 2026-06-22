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

//! The remote source adapter's pure half (spec §6.2, D-03 — the M1 slice).
//!
//! A remote source is described by `{url, format, params}`
//! ([`SourceKind::Remote`]) and stays **transport-agnostic**: this module
//! validates the descriptor and computes its deterministic
//! **content-hash invalidation key** — it NEVER fetches. The actual bytes are
//! supplied by the caller (the bundle realm, edit-time, post-consent), exactly
//! the seam the file adapter uses (DuckDB reads bundle-supplied bytes; the
//! wasm kernel performs no IO).
//!
//! Security shape (§11, rfc-credential-store): the descriptor carries NO
//! credential material — a URL with embedded `user:pass@` userinfo is
//! **rejected at validation**; authenticated sources name a host-store secret
//! via `credential_ref` (a ref string, resolved host-side, never in the
//! document payload).

use std::collections::BTreeMap;

use thiserror::Error;

use data_core::{FileFormat, SourceKind};

/// A malformed remote-source descriptor (§6.2/§11). Surfaced, never bypassed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RemoteError {
    #[error("remote url must be http(s), got `{0}`")]
    UnsupportedScheme(String),
    #[error("remote url has no host")]
    MissingHost,
    #[error("remote url embeds credentials (user:pass@) — use a credential_ref (D-11)")]
    EmbeddedCredentials,
    #[error("source is not a remote source")]
    NotRemote,
}

/// Validate a remote descriptor (§6.2/§11): the URL must be `http(s)://` with
/// a host, and must NOT embed userinfo credentials — secret material travels
/// only as a `credential_ref` into the host store (rfc-credential-store).
pub fn validate_remote(kind: &SourceKind) -> Result<(), RemoteError> {
    let SourceKind::Remote { url, .. } = kind else {
        return Err(RemoteError::NotRemote);
    };
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err(RemoteError::UnsupportedScheme(url.clone()));
    };
    if scheme != "http" && scheme != "https" {
        return Err(RemoteError::UnsupportedScheme(format!("{scheme}://")));
    }
    let authority = rest.split('/').next().unwrap_or(rest);
    if authority.contains('@') {
        return Err(RemoteError::EmbeddedCredentials);
    }
    if authority.is_empty() {
        return Err(RemoteError::MissingHost);
    }
    Ok(())
}

/// The deterministic hash of the remote *descriptor* (url + format + params).
/// `params` is a `BTreeMap`, so insertion order never changes the key.
pub fn remote_descriptor_hash(
    url: &str,
    format: Option<FileFormat>,
    params: &BTreeMap<String, String>,
) -> u64 {
    let mut h = FNV_OFFSET;
    fnv_bytes(&mut h, url.as_bytes());
    fnv_bytes(&mut h, &[0xff]);
    fnv_bytes(&mut h, format_tag(format).as_bytes());
    for (k, v) in params {
        fnv_bytes(&mut h, &[0xfe]);
        fnv_bytes(&mut h, k.as_bytes());
        fnv_bytes(&mut h, &[0xfd]);
        fnv_bytes(&mut h, v.as_bytes());
    }
    h
}

/// A stable content hash over fetched bytes (FNV-1a 64) — the byte half of the
/// invalidation key. Pure: the bytes are SUPPLIED by the caller.
pub fn content_hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    fnv_bytes(&mut h, bytes);
    h
}

/// The **content-hash invalidation key** for a remote source (§8 shaping):
/// descriptor hash ⊕-combined with the content hash of the (caller-supplied)
/// fetched bytes. Equal keys ⇒ the source's contribution to a resolve stamp is
/// unchanged ⇒ no re-resolution; a changed payload OR a changed descriptor
/// invalidates. Validates the descriptor first — an invalid remote source has
/// no key.
pub fn remote_invalidation_key(kind: &SourceKind, bytes: &[u8]) -> Result<u64, RemoteError> {
    validate_remote(kind)?;
    let SourceKind::Remote {
        url,
        format,
        params,
        ..
    } = kind
    else {
        return Err(RemoteError::NotRemote);
    };
    let mut h = remote_descriptor_hash(url, *format, params);
    fnv_bytes(&mut h, &content_hash_bytes(bytes).to_le_bytes());
    Ok(h)
}

/// A stable tag per format (the serde lowercase name; `none` when inferred).
fn format_tag(format: Option<FileFormat>) -> &'static str {
    match format {
        None => "none",
        Some(FileFormat::Csv) => "csv",
        Some(FileFormat::Tsv) => "tsv",
        Some(FileFormat::Json) => "json",
        Some(FileFormat::Parquet) => "parquet",
        Some(FileFormat::Excel) => "excel",
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_bytes(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= u64::from(*b);
        *h = h.wrapping_mul(FNV_PRIME);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(url: &str) -> SourceKind {
        SourceKind::Remote {
            url: url.into(),
            format: Some(FileFormat::Csv),
            params: BTreeMap::new(),
            credential_ref: None,
        }
    }

    #[test]
    fn data_source_remote_validate() {
        assert!(validate_remote(&remote("https://api.test/data.csv")).is_ok());
        assert!(validate_remote(&remote("http://api.test/data.csv")).is_ok());
        assert_eq!(
            validate_remote(&remote("ftp://api.test/x")),
            Err(RemoteError::UnsupportedScheme("ftp://".into()))
        );
        assert_eq!(
            validate_remote(&remote("api.test/x")),
            Err(RemoteError::UnsupportedScheme("api.test/x".into()))
        );
        assert_eq!(
            validate_remote(&remote("https:///x")),
            Err(RemoteError::MissingHost)
        );
        assert_eq!(
            validate_remote(&remote("https://user:pass@api.test/x")),
            Err(RemoteError::EmbeddedCredentials)
        );
    }

    #[test]
    fn data_source_remote_invalidation_key_is_deterministic() {
        let k = remote("https://api.test/d.csv");
        let a = remote_invalidation_key(&k, b"a,b\n1,2\n").unwrap();
        let b = remote_invalidation_key(&k, b"a,b\n1,2\n").unwrap();
        assert_eq!(a, b);
        // Changed payload ⇒ changed key.
        assert_ne!(a, remote_invalidation_key(&k, b"a,b\n1,3\n").unwrap());
        // Changed descriptor ⇒ changed key (same bytes).
        let other = remote("https://api.test/other.csv");
        assert_ne!(a, remote_invalidation_key(&other, b"a,b\n1,2\n").unwrap());
    }
}
