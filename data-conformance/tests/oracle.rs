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

//! Env-gated native-DuckDB differential oracle skeleton (spec §12.4). DuckDB
//! itself is the query oracle: expected result sets computed by native DuckDB
//! are diffed against DuckDB-WASM (parity across the two builds). The real
//! harness lands at M1 with the engine wiring; M0 ships the gated skeleton so
//! the lane exists. Run with:
//!
//! ```sh
//! PAGED_DATA_ORACLE=1 cargo test -p data-conformance -- --ignored
//! ```

#[test]
#[ignore = "native-DuckDB oracle; set PAGED_DATA_ORACLE=1"]
fn data_oracle_duckdb_parity_skeleton() {
    if std::env::var("PAGED_DATA_ORACLE").is_err() {
        eprintln!("SKIP: set PAGED_DATA_ORACLE=1 to run the native-DuckDB oracle");
        return;
    }
    // M1: run a query through native DuckDB and assert parity with the
    // DuckDB-WASM result the bundle produces (the `data.query.*` parity tier).
    eprintln!("oracle: native-DuckDB parity harness lands at M1 (spec §12.4)");
}
