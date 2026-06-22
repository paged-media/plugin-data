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

//! `paged-data-batch` — the headless batch CLI (spec §10). Reads a JSON [`Job`]
//! from a file argument or stdin, runs it through the engine, and prints the
//! per-document lowered IR as JSON to stdout. A thin IO wrapper over
//! [`data_cli::run_job`] — all logic (and its tests) live in the library.

use std::io::Read;
use std::process::ExitCode;

const USAGE: &str = "\
paged-data-batch — headless batch generation (paged.data §10)

USAGE:
    paged-data-batch [JOB.json]      run the job file
    paged-data-batch < JOB.json      run a job from stdin

The job is { today, locale?, payload, results, binding?, mode?, chain, opts?,
script? }. Pre-materialize the query `results` yourself (the CLI does not query).
An optional constrained `script` (sandboxed Boa) may compute the params/locale/
build for the run. Prints { documentCount, runs: [{ label, flow }] } — the
per-document lowered IR — to stdout; errors + diagnostics go to stderr. Exit 0 on
success, 1 on failure.";

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    if matches!(arg.as_deref(), Some("-h") | Some("--help")) {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let input = match arg {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("paged-data-batch: cannot read '{path}': {e}");
                return ExitCode::FAILURE;
            }
        },
        None => {
            let mut s = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut s) {
                eprintln!("paged-data-batch: cannot read stdin: {e}");
                return ExitCode::FAILURE;
            }
            s
        }
    };

    let job: data_cli::Job = match serde_json::from_str(&input) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("paged-data-batch: invalid job JSON: {e}");
            return ExitCode::FAILURE;
        }
    };

    match data_cli::run_job(job) {
        Ok(out) => match serde_json::to_string_pretty(&out) {
            Ok(json) => {
                eprintln!(
                    "paged-data-batch: generated {} document(s)",
                    out.document_count
                );
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("paged-data-batch: cannot serialize output: {e}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("paged-data-batch: {e}");
            ExitCode::FAILURE
        }
    }
}
