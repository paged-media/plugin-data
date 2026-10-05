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

//! Civil-date arithmetic (no `chrono` dependency — keeps the wasm budget lean,
//! D-4). [`Value::Date`](crate::value::Value::Date) is days since 1970-01-01;
//! these are Howard Hinnant's public-domain `days_from_civil` /
//! `civil_from_days` algorithms (chrono::civil), bit-stable across platforms.

/// Days since 1970-01-01 for a proleptic-Gregorian civil date. Valid for any
/// `y`; `m` in `1..=12`, `d` in `1..=31`.
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i32 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as u32; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe as i32 - 719468
}

/// Civil `(year, month, day)` for a count of days since 1970-01-01.
///
/// Computed in `i64`: the shift by 719 468 overflows `i32` within that many
/// days of `i32::MAX` (DuckDB's DATE range reaches there), and every `i32`
/// day count maps to a year that fits `i32`.
pub fn civil_from_days(z: i32) -> (i32, u32, u32) {
    let z = z as i64 + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parse an ISO-8601 `YYYY-MM-DD` date to days since 1970-01-01. Returns `None`
/// on any malformed input (the caller maps that to a parse error).
pub fn parse_iso_date(s: &str) -> Option<i32> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_temporal_civil_from_days_extremes_do_not_overflow() {
        // DuckDB's DATE max (5881580-07-10) and min (5877642-06-25 BC).
        assert_eq!(civil_from_days(2_147_483_646), (5_881_580, 7, 10));
        assert_eq!(civil_from_days(-2_147_483_646), (-5_877_641, 6, 25));
        assert_eq!(civil_from_days(i32::MAX).0, 5_881_580);
        assert_eq!(civil_from_days(i32::MIN).0, -5_877_641);
    }

    #[test]
    fn data_temporal_civil_roundtrip() {
        for &(y, m, d) in &[(1970, 1, 1), (2000, 2, 29), (1999, 12, 31), (2026, 6, 8)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d));
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn data_temporal_parse_iso() {
        assert_eq!(parse_iso_date("1970-01-01"), Some(0));
        assert_eq!(
            parse_iso_date("2026-06-08"),
            Some(days_from_civil(2026, 6, 8))
        );
        assert_eq!(parse_iso_date("not-a-date"), None);
        assert_eq!(parse_iso_date("2026-13-01"), None);
    }
}
