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

//! The InDesign Data Merge oracle replay (docs/design/oracles.md).
//!
//! `conformance/indesign-merge/record.sh` asked Adobe InDesign 2025 to merge
//! every fixture in `fixtures.json` and committed what it did to
//! `recorded/<id>.json`: pages, and on each page every record frame (bounds,
//! text, overset) and every image frame. This file replays those recordings
//! WITHOUT InDesign, three ways:
//!
//! 1. **The rule** — a closed-form statement of InDesign's Multiple Record
//!    Layout (records per column = ⌊(H + rowSpacing) / (h + rowSpacing)⌋,
//!    columns = ⌊(W + colSpacing) / (w + colSpacing)⌋, record k on page
//!    ⌊k / (rows·cols)⌋, rows-first or columns-first, every frame on that grid
//!    within ±0.5 pt). It must reproduce every recording exactly. It is what
//!    the merge writer (campaign Wave 5) implements.
//! 2. **The merge planner** — `DataSession::plan_merge` (`data_lower::merge`,
//!    Wave 5) over the CSV: Data Merge itself. It reproduces every recording
//!    except the overset flag, which needs text measurement and is the host
//!    writer's job (`packages/data-bundle/test/merge-real-core.spec.ts`).
//!
//!    **The record flow** — the EasyCatalog-style flow binding, kept as a
//!    reference lane: `DataSession` resolves
//!    a record-flow binding over the CSV and `paginate_flow` packs it into the
//!    natural chain (one frame per page of the template frame's height for
//!    Single Record; per page one frame per column of the margin box height
//!    for Multiple Records). Scored against InDesign and PINNED: a score
//!    that changes fails, so a fix updates its pin in the same commit.
//! 3. **The paginator at InDesign's pitch** — `paginate_flow` alone, fed
//!    InDesign's record pitch (frame height + row spacing) and CSV order:
//!    the packing arithmetic without our template model.
//!
//! The score of a lane against InDesign: page count, placements that agree
//! (same page, grid row and column, same text), texts that agree regardless
//! of place, overset flags and image names. Texts are compared after
//! normalisation: `\r` → `\n`, U+FEFF (the marks InDesign leaves where an
//! empty placeholder was) removed; an overset InDesign frame shows only the
//! text that fits, so ours must START with it.

// `__feat__<id>` test names: the cockpit test-to-feature join.
#![allow(non_snake_case)]

use std::collections::BTreeSet;
use std::path::PathBuf;

use data_conformance::today;
use data_core::{
    Binding, BindingDef, BindingId, FieldType, FlowOpts, FrameChainRef, Query, QueryId, RecordSet,
    ResultShape, Schema, Template, TemplateField, TemplateRef, Value,
};
use data_js::core::DataSession;
use data_lower::{
    paginate_flow, FlowBlock, FlowGroup, FlowLayoutOpts, FlowRecord, FrameCapacity, PaginatedFlow,
};
use serde_json::Value as J;

/// Geometry tolerance against InDesign's recorded bounds (pt).
const TOL_PT: f64 = 0.5;

fn lane() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance/indesign-merge")
}

fn read_json(path: PathBuf) -> J {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

// ── fixtures ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Fixture {
    id: String,
    /// The record's text frame [y1, x1, y2, x2].
    text_bounds: [f64; 4],
    lines: Vec<String>,
    image_field: Option<String>,
    /// The image frame [y1, x1, y2, x2], when the template has one.
    image_bounds: Option<[f64; 4]>,
    multiple: bool,
    rows_first: bool,
    row_spacing: f64,
    col_spacing: f64,
    remove_blank: bool,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    /// Margin box: top, left, width, height.
    content: [f64; 4],
    leading: f64,
}

impl Fixture {
    fn h(&self) -> f64 {
        self.text_bounds[2] - self.text_bounds[0]
    }
    fn w(&self) -> f64 {
        self.text_bounds[3] - self.text_bounds[1]
    }
    fn col(&self, name: &str) -> usize {
        self.header
            .iter()
            .position(|h| h == name)
            .unwrap_or_else(|| panic!("{}: no column {name}", self.id))
    }
    /// (rows per column, columns) of the Multiple Record grid.
    fn grid(&self) -> (usize, usize) {
        let rows = ((self.content[3] + self.row_spacing) / (self.h() + self.row_spacing)).floor();
        let cols = ((self.content[2] + self.col_spacing) / (self.w() + self.col_spacing)).floor();
        (rows.max(1.0) as usize, cols.max(1.0) as usize)
    }
    /// Data Merge's own rendering of record `k`: every <<field>> replaced by
    /// the field text verbatim; with Remove Blank Lines, a line whose fields
    /// are all empty and that has nothing else on it disappears.
    fn merged_text(&self, k: usize) -> String {
        let row = &self.rows[k];
        let mut out = Vec::new();
        for line in &self.lines {
            let mut text = line.clone();
            let mut all_empty = true;
            let mut only_fields = true;
            let mut rest = line.as_str();
            while let Some(start) = rest.find("<<") {
                if !rest[..start].trim().is_empty() {
                    only_fields = false;
                }
                let end = rest[start..].find(">>").expect("closed placeholder") + start;
                let name = &rest[start + 2..end];
                let value = &row[self.col(name)];
                if !value.is_empty() {
                    all_empty = false;
                }
                text = text.replacen(&format!("<<{name}>>"), value, 1);
                rest = &rest[end + 2..];
            }
            if !rest.trim().is_empty() {
                only_fields = false;
            }
            if self.remove_blank && all_empty && only_fields {
                continue;
            }
            out.push(text);
        }
        out.join("\n")
    }
}

/// RFC 4180: quoted fields, doubled quotes, CRLF/LF records, newlines in quotes.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                field.push('"');
            }
            (true, '"') => quoted = false,
            (true, c) => field.push(c),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut field)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            (false, c) => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn fixtures() -> Vec<Fixture> {
    let spec = read_json(lane().join("fixtures.json"));
    let page = &spec["page"];
    let m = &page["margins"];
    let f = |v: &J| v.as_f64().expect("number");
    let content = [
        f(&m["top"]),
        f(&m["left"]),
        f(&page["width"]) - f(&m["left"]) - f(&m["right"]),
        f(&page["height"]) - f(&m["top"]) - f(&m["bottom"]),
    ];
    spec["fixtures"]
        .as_array()
        .expect("fixtures")
        .iter()
        .map(|fx| {
            let id = fx["id"].as_str().unwrap().to_string();
            let frames = fx["frames"].as_array().unwrap();
            let text = frames
                .iter()
                .find(|fr| fr["kind"] == "text")
                .expect("a text frame");
            let b: Vec<f64> = text["bounds"].as_array().unwrap().iter().map(f).collect();
            let image = frames.iter().find(|fr| fr["kind"] == "image");
            let image_field = image.map(|fr| fr["field"].as_str().unwrap().to_string());
            let image_bounds = image.map(|fr| {
                let b: Vec<f64> = fr["bounds"].as_array().unwrap().iter().map(f).collect();
                [b[0], b[1], b[2], b[3]]
            });
            let merge = &fx["merge"];
            let mut csv = parse_csv(
                &std::fs::read_to_string(lane().join("csv").join(format!("{id}.csv"))).unwrap(),
            );
            let header = csv.remove(0);
            Fixture {
                id,
                text_bounds: [b[0], b[1], b[2], b[3]],
                lines: text["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| l.as_str().unwrap().to_string())
                    .collect(),
                image_field,
                image_bounds,
                multiple: merge["recordsPerPage"] == "multiple",
                rows_first: merge["arrangeBy"] != "columns",
                row_spacing: merge["rowSpacing"].as_f64().unwrap_or(0.0),
                col_spacing: merge["columnSpacing"].as_f64().unwrap_or(0.0),
                remove_blank: merge["removeBlankLines"] == true,
                header,
                rows: csv,
                content,
                leading: f(&spec["text"]["leading"]),
            }
        })
        .collect()
}

fn fixture(id: &str) -> Fixture {
    fixtures()
        .into_iter()
        .find(|f| f.id == id)
        .unwrap_or_else(|| panic!("no fixture {id}"))
}

// ── layouts ─────────────────────────────────────────────────────────────────

/// One merged record as placed.
#[derive(Debug, Clone)]
struct Placed {
    page: usize,
    row: usize,
    col: usize,
    text: String,
    overset: bool,
    image: Option<String>,
}

#[derive(Debug, Clone)]
struct Layout {
    pages: usize,
    placed: Vec<Placed>,
}

fn normalise(s: &str) -> String {
    s.replace('\r', "\n").replace('\u{feff}', "")
}

/// The (row, column) of a record text frame on the Data Merge grid, or `None`
/// when its bounds are off the grid or not the template's size by more than
/// TOL_PT.
fn on_grid(fx: &Fixture, b: &[f64]) -> Option<(usize, usize)> {
    let pitch_y = fx.h() + fx.row_spacing;
    let pitch_x = fx.w() + fx.col_spacing;
    let (dy, dx) = (b[0] - fx.text_bounds[0], b[1] - fx.text_bounds[1]);
    let (row, col) = ((dy / pitch_y).round(), (dx / pitch_x).round());
    let ok = row >= 0.0
        && col >= 0.0
        && (dy - row * pitch_y).abs() <= TOL_PT
        && (dx - col * pitch_x).abs() <= TOL_PT
        && ((b[2] - b[0]) - fx.h()).abs() <= TOL_PT
        && ((b[3] - b[1]) - fx.w()).abs() <= TOL_PT;
    ok.then_some((row as usize, col as usize))
}

/// InDesign's merged document as a layout: each text frame placed on the
/// record grid by its recorded bounds. Panics when a frame is off the grid by
/// more than TOL_PT — the recording would contradict the grid model.
fn indesign_layout(fx: &Fixture) -> Layout {
    let rec = read_json(lane().join("recorded").join(format!("{}.json", fx.id)));
    let merged = &rec["merged"];
    let pages = merged["pages"].as_array().expect("pages");
    assert_eq!(merged["page_count"].as_u64().unwrap() as usize, pages.len());
    let mut placed = Vec::new();
    for (p, page) in pages.iter().enumerate() {
        let images: Vec<Option<String>> = page["rectangles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["graphic"]["name"].as_str().map(str::to_string))
            .collect();
        for tf in page["text_frames"].as_array().unwrap() {
            let b: Vec<f64> = tf["bounds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            let (row, col) = on_grid(fx, &b).unwrap_or_else(|| {
                panic!("{}: page {p} frame {b:?} is off the record grid", fx.id)
            });
            placed.push(Placed {
                page: p,
                row,
                col,
                text: normalise(tf["text"].as_str().unwrap()),
                overset: tf["overset"].as_bool().unwrap(),
                // Single Record: one image frame per page, beside the record.
                image: if fx.image_field.is_some() {
                    images.first().cloned().flatten()
                } else {
                    None
                },
            });
        }
    }
    Layout {
        pages: pages.len(),
        placed,
    }
}

/// The closed-form Data Merge rule (module docs, 1.) applied to CSV order.
fn rule_layout(fx: &Fixture) -> Layout {
    let image_col = fx.image_field.as_ref().map(|f| fx.col(f));
    let mut placed = Vec::new();
    let per_page = if fx.multiple {
        fx.grid().0 * fx.grid().1
    } else {
        1
    };
    let (rows, cols) = fx.grid();
    for k in 0..fx.rows.len() {
        let (page, slot) = (k / per_page, k % per_page);
        let (row, col) = match (fx.multiple, fx.rows_first) {
            (false, _) => (0, 0),
            (true, true) => (slot / cols, slot % cols),
            (true, false) => (slot % rows, slot / rows),
        };
        placed.push(Placed {
            page,
            row,
            col,
            text: fx.merged_text(k),
            overset: false,
            image: image_col.map(|c| fx.rows[k][c].clone()),
        });
    }
    Layout {
        pages: fx.rows.len().div_ceil(per_page),
        placed,
    }
}

/// `chain[i]` frame ids are "<page>:<col>".
fn chain(fx: &Fixture, cap: f64) -> Vec<FrameCapacity> {
    let cols = if fx.multiple { fx.grid().1 } else { 1 };
    (0..fx.rows.len())
        .flat_map(|p| {
            (0..cols).map(move |c| FrameCapacity {
                frame: format!("{p}:{c}"),
                page: p.to_string(),
                height_pt: cap,
            })
        })
        .collect()
}

fn flow_layout(flow: &PaginatedFlow, cap: f64) -> Layout {
    let mut placed = Vec::new();
    let mut pages = BTreeSet::new();
    for frame in &flow.frames {
        let (p, c) = frame.frame.split_once(':').unwrap();
        let (p, c): (usize, usize) = (p.parse().unwrap(), c.parse().unwrap());
        pages.insert(p);
        let mut used = 0.0;
        let mut row = 0;
        for block in &frame.blocks {
            if let FlowBlock::Record { cells, height_pt } = block {
                used += height_pt;
                placed.push(Placed {
                    page: p,
                    row,
                    col: c,
                    text: cells.join("\n"),
                    overset: used > cap + 1e-9,
                    image: None,
                });
                row += 1;
            }
        }
    }
    Layout {
        pages: pages.len(),
        placed,
    }
}

/// Our record flow end to end: DataSession over the CSV (every field TEXT,
/// as Data Merge reads it; an empty field is null, as DuckDB reads it).
fn session_over_csv(fx: &Fixture) -> DataSession {
    let mut s = DataSession::new(today());
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: String::new(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    let schema = Schema::from_fields(fx.header.iter().map(|h| (h.clone(), FieldType::Text)));
    let columns = (0..fx.header.len())
        .map(|c| {
            fx.rows
                .iter()
                .map(|r| {
                    if r[c].is_empty() {
                        Value::Null
                    } else {
                        Value::text(&r[c])
                    }
                })
                .collect()
        })
        .collect();
    s.ingest_result(QueryId::from("q"), RecordSet::new(schema, columns).unwrap());
    s
}

fn flow_layout_of_engine(fx: &Fixture) -> Layout {
    let mut s = session_over_csv(fx);
    let fields = fx
        .lines
        .iter()
        .map(|line| {
            let start = line.find("<<").expect("every template line has one field");
            assert!(
                line.ends_with(">>") && !line[start + 2..].contains("<<"),
                "{line}: label<<field>> only"
            );
            TemplateField {
                label: line[..start].to_string(),
                expr: line[start + 2..line.len() - 2].to_string(),
            }
        })
        .collect();
    s.define_template(Template {
        id: TemplateRef::from("t"),
        fields,
        line_height_pt: fx.leading,
    });
    s.define_binding(BindingDef {
        id: BindingId::from("rf"),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("chain"),
            query: QueryId::from("q"),
            template: TemplateRef::from("t"),
            options: FlowOpts::default(),
        },
    });
    let cap = if fx.multiple { fx.content[3] } else { fx.h() };
    let flow = s
        .lower_record_flow(
            &BindingId::from("rf"),
            chain(fx, cap),
            FlowLayoutOpts::default(),
        )
        .unwrap();
    assert!(
        !flow.overflow,
        "{}: the chain is long enough for every record",
        fx.id
    );
    flow_layout(&flow, cap)
}

/// The Data Merge planner (`data_lower::merge`, Wave 5) end to end through
/// `DataSession::plan_merge`, over the same TEXT ingest as the flow lane.
/// Every planned text frame is placed on the grid FROM ITS BOUNDS (as
/// InDesign's frames are), so a planner that put a frame in the wrong place
/// fails the grid check instead of scoring by its own claim. The planner
/// does not measure text, so it never claims overset (DM-7 is measured by
/// the host writer: packages/data-bundle/test/merge-real-core.spec.ts).
fn merge_layout(fx: &Fixture) -> Layout {
    use data_lower::merge::{
        MergeArrange, MergeFrameContent, MergeSpec, MergeTemplateFrame, RecordsPerPage,
    };
    let s = session_over_csv(fx);
    let mut frames = vec![MergeTemplateFrame {
        id: "text".into(),
        bounds: fx.text_bounds,
        content: MergeFrameContent::Text {
            text: fx.lines.join("\n"),
        },
    }];
    if let (Some(field), Some(bounds)) = (&fx.image_field, fx.image_bounds) {
        frames.push(MergeTemplateFrame {
            id: "image".into(),
            bounds,
            content: MergeFrameContent::Image {
                field: field.clone(),
            },
        });
    }
    let c = fx.content;
    let spec = MergeSpec {
        margin_box: [c[0], c[1], c[0] + c[3], c[1] + c[2]],
        frames,
        records_per_page: if fx.multiple {
            RecordsPerPage::Multiple {
                arrange: if fx.rows_first {
                    MergeArrange::Rows
                } else {
                    MergeArrange::Columns
                },
                row_spacing_pt: fx.row_spacing,
                column_spacing_pt: fx.col_spacing,
            }
        } else {
            RecordsPerPage::Single
        },
        remove_blank_lines: fx.remove_blank,
    };
    let plan = s.plan_merge(&QueryId::from("q"), &spec).unwrap();
    assert!(
        plan.missing_fields.is_empty(),
        "{}: {:?}",
        fx.id,
        plan.missing_fields
    );
    let placed = plan
        .records
        .iter()
        .map(|r| {
            let text = &r.frames[0];
            let (row, col) = on_grid(fx, &text.bounds).unwrap_or_else(|| {
                panic!(
                    "{}: planned frame {:?} is off the record grid",
                    fx.id, text.bounds
                )
            });
            if let (Some(img), Some(b)) = (r.frames.get(1), fx.image_bounds) {
                // The image frame keeps its offset from the text frame.
                let (dy, dx) = (
                    text.bounds[0] - fx.text_bounds[0],
                    text.bounds[1] - fx.text_bounds[1],
                );
                assert_eq!(
                    img.bounds,
                    [b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx],
                    "{}",
                    fx.id
                );
            }
            Placed {
                page: r.page,
                row,
                col,
                text: text.text.clone().unwrap_or_default(),
                overset: false,
                image: r.frames.get(1).and_then(|f| f.image.clone()),
            }
        })
        .collect();
    Layout {
        pages: plan.page_count,
        placed,
    }
}

/// `paginate_flow` alone at InDesign's pitch, CSV order, Data Merge's text.
fn paginator_layout(fx: &Fixture) -> Layout {
    let (cap, h) = if fx.multiple {
        (fx.content[3] + fx.row_spacing, fx.h() + fx.row_spacing)
    } else {
        (fx.h(), fx.h())
    };
    let records = (0..fx.rows.len())
        .map(|k| FlowRecord {
            cells: vec![fx.merged_text(k)],
            height_pt: h,
        })
        .collect();
    let groups = [FlowGroup {
        header: None,
        level: 0,
        records,
        footer: None,
    }];
    flow_layout(
        &paginate_flow(&groups, &chain(fx, cap), &FlowLayoutOpts::default()),
        cap,
    )
}

// ── scoring ─────────────────────────────────────────────────────────────────

/// How far a lane agrees with InDesign. Every count is out of InDesign's
/// record count (`of`), except `pages`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Score {
    /// (ours, InDesign)
    pages: (usize, usize),
    /// Same page, row, column AND text.
    placed: usize,
    /// Same text, anywhere.
    texts: usize,
    /// Records whose overset flag agrees (matched by text).
    overset: usize,
    /// Records whose image agrees (matched by text); 0 when the fixture has none.
    images: usize,
    of: usize,
}

fn text_eq(ours: &str, theirs: &Placed) -> bool {
    if theirs.overset {
        ours.starts_with(theirs.text.trim_end()) && !theirs.text.is_empty()
    } else {
        ours == theirs.text
    }
}

fn score(ours: &Layout, theirs: &Layout) -> Score {
    let mut placed = 0;
    for t in &theirs.placed {
        if ours
            .placed
            .iter()
            .any(|o| o.page == t.page && o.row == t.row && o.col == t.col && text_eq(&o.text, t))
        {
            placed += 1;
        }
    }
    let (mut texts, mut overset, mut images) = (0, 0, 0);
    let mut used = vec![false; ours.placed.len()];
    for t in &theirs.placed {
        if let Some(i) =
            (0..ours.placed.len()).find(|&i| !used[i] && text_eq(&ours.placed[i].text, t))
        {
            used[i] = true;
            texts += 1;
            if ours.placed[i].overset == t.overset {
                overset += 1;
            }
            if t.image.is_some() && ours.placed[i].image == t.image {
                images += 1;
            }
        }
    }
    Score {
        pages: (ours.pages, theirs.pages),
        placed,
        texts,
        overset,
        images,
        of: theirs.placed.len(),
    }
}

fn report(lane: &str, fx: &Fixture, s: Score) {
    eprintln!(
        "oracle {lane:<9} {:<20} pages {}/{}  placed {}/{}  texts {}/{}  overset {}/{}  images {}",
        fx.id, s.pages.0, s.pages.1, s.placed, s.of, s.texts, s.of, s.overset, s.of, s.images
    );
}

// ── 1. the rule reproduces every recording ─────────────────────────────────

#[test]
fn data_oracle_indesign_recordings_are_present_and_consistent__feat__data_lower_content() {
    let fxs = fixtures();
    assert_eq!(fxs.len(), 8);
    for fx in &fxs {
        let rec = read_json(lane().join("recorded").join(format!("{}.json", fx.id)));
        assert!(
            rec["indesign_version"].as_str().unwrap().starts_with("20."),
            "{}: InDesign 2025",
            fx.id
        );
        assert!(lane()
            .join("templates")
            .join(format!("{}.idml", fx.id))
            .exists());
        // Every record merged exactly once.
        assert_eq!(indesign_layout(fx).placed.len(), fx.rows.len(), "{}", fx.id);
    }
}

#[test]
fn data_oracle_indesign_merge_rule_reproduces_every_recording__feat__data_lower_content() {
    for fx in fixtures() {
        let s = score(&rule_layout(&fx), &indesign_layout(&fx));
        report("rule", &fx, s);
        let images = if fx.image_field.is_some() { s.of } else { 0 };
        // The rule renders text in full; an overset InDesign frame is matched
        // by prefix, and the rule never claims overset itself.
        let overset_frames = indesign_layout(&fx)
            .placed
            .iter()
            .filter(|p| p.overset)
            .count();
        assert_eq!(
            s,
            Score {
                pages: (s.pages.1, s.pages.1),
                placed: s.of,
                texts: s.of,
                overset: s.of - overset_frames,
                images,
                of: s.of
            },
            "{}: the Data Merge rule disagrees with InDesign",
            fx.id
        );
    }
}

// ── 2./3. our lanes, pinned ─────────────────────────────────────────────────

/// What each lane scores against InDesign today. A row that is not a full
/// agreement names the defect it pins (campaign Wave 5 fixes them) or the
/// documented divergence. When a score moves, update the pin in the commit
/// that moved it.
struct Pin {
    fixture: &'static str,
    /// The Data Merge planner (Wave 5): what InDesign does.
    merge: Score,
    /// The record-flow binding: EasyCatalog-style continuous flow, NOT Data
    /// Merge. Its divergences from InDesign are what the flow is (records
    /// packed by template height, stable re-sorted identity, no image
    /// field); Data Merge is the merge lane.
    flow: Score,
    paginator: Score,
    why: &'static str,
}

fn sc(
    pages: (usize, usize),
    placed: usize,
    texts: usize,
    overset: usize,
    images: usize,
    of: usize,
) -> Score {
    Score {
        pages,
        placed,
        texts,
        overset,
        images,
        of,
    }
}

/// Marks a merge pin as "full agreement with InDesign" (see [`full`]).
const MERGE_FULL: Score = Score {
    pages: (0, 0),
    placed: 0,
    texts: 0,
    overset: 0,
    images: 0,
    of: usize::MAX,
};

/// Full agreement with a recording: every page, placement, text, overset
/// flag and image.
fn full(theirs: &Layout) -> Score {
    let of = theirs.placed.len();
    Score {
        pages: (theirs.pages, theirs.pages),
        placed: of,
        texts: of,
        overset: of,
        images: theirs.placed.iter().filter(|p| p.image.is_some()).count(),
        of,
    }
}

fn pins() -> Vec<Pin> {
    vec![
        // PINS_START
        Pin {
            fixture: "single-record",
            merge: MERGE_FULL,
            flow: sc((2, 3), 0, 3, 3, 0, 3),
            paginator: sc((3, 3), 3, 3, 3, 0, 3),
            why: "flow: no Single Record mode, records re-sorted (DM-1/DM-2 are closed for Data Merge by the merge lane)",
        },
        Pin {
            fixture: "multi-record-column",
            merge: MERGE_FULL,
            flow: sc((1, 2), 10, 12, 12, 0, 12),
            paginator: sc((2, 2), 12, 12, 12, 0, 12),
            why: "flow: record pitch is lines x leading, not frame height + row spacing (DM-3 closed by the merge lane)",
        },
        Pin {
            fixture: "multi-record-grid",
            merge: MERGE_FULL,
            flow: sc((1, 1), 1, 7, 7, 0, 7),
            paginator: sc((1, 1), 1, 7, 7, 0, 7),
            why: "flow: the chain fills column by column (DM-4 closed by the merge lane)",
        },
        Pin {
            fixture: "long-record-set",
            merge: MERGE_FULL,
            flow: sc((2, 3), 0, 57, 57, 0, 57),
            paginator: sc((3, 3), 57, 57, 57, 0, 57),
            why: "flow: records re-sorted, pitch (DM-2/DM-3 closed by the merge lane)",
        },
        Pin {
            fixture: "empty-field-lines",
            merge: MERGE_FULL,
            flow: sc((2, 3), 1, 2, 2, 0, 3),
            paginator: sc((3, 3), 3, 3, 3, 0, 3),
            why: "flow: no Remove Blank Lines (DM-5 closed by the merge lane)",
        },
        Pin {
            fixture: "overset",
            merge: sc((2, 2), 2, 2, 1, 0, 2),
            flow: sc((2, 2), 0, 2, 1, 0, 2),
            paginator: sc((2, 2), 2, 2, 1, 0, 2),
            why: "merge: the planner does not measure text, so it never claims overset; DM-7 is measured by the host writer (merge-real-core.spec.ts). flow/paginator cannot know by construction",
        },
        Pin {
            fixture: "number-text",
            merge: MERGE_FULL,
            flow: sc((2, 3), 1, 3, 3, 0, 3),
            paginator: sc((3, 3), 3, 3, 3, 0, 3),
            why: "texts agree verbatim over a TEXT ingest (the DuckDB-typed path is DM-8, duckdb-sql-oracle.spec.ts)",
        },
        Pin {
            fixture: "image-field",
            merge: MERGE_FULL,
            flow: sc((2, 3), 0, 3, 3, 0, 3),
            paginator: sc((3, 3), 3, 3, 3, 0, 3),
            why: "flow: a record-flow template has no image field (DM-6 closed by the merge lane)",
        },
        // PINS_END
    ]
}

fn check(id: &str) {
    let fx = fixture(id);
    let theirs = indesign_layout(&fx);
    let merge = score(&merge_layout(&fx), &theirs);
    let flow = score(&flow_layout_of_engine(&fx), &theirs);
    let paginator = score(&paginator_layout(&fx), &theirs);
    report("merge", &fx, merge);
    report("flow", &fx, flow);
    report("paginator", &fx, paginator);
    let pin = pins()
        .into_iter()
        .find(|p| p.fixture == id)
        .unwrap_or_else(|| panic!("no pin for {id}"));
    let merge_pin = if pin.merge == MERGE_FULL {
        full(&theirs)
    } else {
        pin.merge
    };
    assert_eq!(
        merge, merge_pin,
        "{id}: the merge planner's score moved ({})",
        pin.why
    );
    assert_eq!(
        flow, pin.flow,
        "{id}: the record flow's score moved ({})",
        pin.why
    );
    assert_eq!(
        paginator, pin.paginator,
        "{id}: the paginator's score moved ({})",
        pin.why
    );
}

#[test]
fn data_oracle_indesign_single_record__feat__data_lower_content() {
    check("single-record");
}
#[test]
fn data_oracle_indesign_multi_record_column__feat__data_lower_content() {
    check("multi-record-column");
}
#[test]
fn data_oracle_indesign_multi_record_grid__feat__data_lower_content() {
    check("multi-record-grid");
}
#[test]
fn data_oracle_indesign_long_record_set__feat__data_lower_content() {
    check("long-record-set");
}
#[test]
fn data_oracle_indesign_empty_field_lines__feat__data_lower_content() {
    check("empty-field-lines");
}
#[test]
fn data_oracle_indesign_overset__feat__data_lower_content() {
    check("overset");
}
#[test]
fn data_oracle_indesign_number_text__feat__data_lower_content() {
    check("number-text");
}
#[test]
fn data_oracle_indesign_image_field__feat__data_lower_content() {
    check("image-field");
}
