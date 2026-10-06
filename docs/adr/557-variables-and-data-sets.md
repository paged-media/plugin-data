# ADR 557 — Variables and data sets are a projection over bindings

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `6b96ce5`.
- **Scope:** `data-dataset`, `Binding::Visibility` in `data-core`, the variable methods of
  `DataSession`, `packages/data-host-model/src/variables.ts`, the Dataset panel

## Context

Adobe Illustrator has a feature called Variables: an author declares named variables (a
text, a linked file, a visibility flag, graph data), captures named data sets, and switches
the artwork between them. This repo implements that feature inside the data plugin.

The commit that added it records why it is here and not in the drawing plugin: the binding
engine is in this repo, and the isolation rule would have forced a drawing plugin to grow a
second data model (commit `6f1ac58`). The crate documentation states the consequence: a
variable is "a **view of a binding**", "a projection over the shipped binding model, not a
second data model" (`data-dataset/src/lib.rs:28-39`).

## Decision

A variable has no storage of its own. Its name is a binding id and its trait follows from
the binding kind; a data set is a captured snapshot of resolved values.

- `variable` bindings project to `textcontent`, `image` to `filereference`, `visibility` to
  `visibility`. Table, record-flow, rule and barcode bindings have no variable.
- `Binding::Visibility` was added for this. The host writes the element's own
  `elementVisible` property; a missing value hides, shows, or (`Leave`) writes nothing.
- `graphdata` variables are read, kept and written back, and never applied.
- `capture_data_set(name, record)` resolves every bindable variable against one record.
  `capture_every_record` makes one data set per record of a query.
- `apply_data_set` returns one row per declared variable that has a value in the set (a
  typed value, or the reason it cannot be written) and marks the applied bindings
  `Overridden`. The bundle writes all rows as one `batch` mutation.
- The variable set travels in `DocumentPayload.variables`.
- Import and export use a codec for Adobe's variable-library XML, with two declared
  deviations: it writes resolved namespace URIs where Illustrator writes DTD entity
  references, and it treats `graphdata` bodies as opaque. The reader matches element names
  by local name, so it accepts either form.

## Evidence

- `data-dataset/src/lib.rs:19-47`, `:73-83`, `:290-311` — the model; `GraphData` carried and
  never resolved; the kind-to-trait map
- `data-dataset/src/xml.rs:44-68` — the two deviations and the local-name reader
- `data-core/src/binding.rs:112-127`, `:158-172` — `Binding::Visibility` and `Leave`
- `data-js/src/core.rs:859-880`, `:969-1010` — capture and apply; apply marks `Overridden`
- `packages/data-host-model/src/variables.ts:117-183` — the plan and the single batch
- `packages/data-bundle/src/activate.ts:129-150` — capture and apply as payload commands
- `data-conformance/tests/variables.rs:610-793` — the XML tests

## Alternatives considered

- **Variables in the drawing plugin.** Declined in commit `6f1ac58`, for the reason above.
- **Resolving graph data by depending on the plugin that owns charts.** Declined: the
  isolation contract forbids it (`data-dataset/src/lib.rs:76-81`).
- **Writing Adobe's DTD entity references.** Declined: those entities are undefined to a
  conforming XML parser, which then rejects the file (`data-dataset/src/xml.rs:46-51`).

## Consequences

Variable names and binding ids are one namespace. An imported variable with no binding of
that name is reported and skipped on apply.

**The interchange was never run against Illustrator.** The codec says so: whether the
application's importer accepts a namespace URI where it wrote an entity is "UNVERIFIED
here — no Illustrator was run" (`data-dataset/src/xml.rs:52-55`). What is tested: a round
trip of the codec's own output for all four traits; reading a sample in the entity form
that is written out in the test source; rejection of unknown traits and undeclared
variables; and that graph data survives import and export. The repo contains no file
produced by the application.

Applying a data set sets `Overridden`, but the bundle's field refresh does not read that
status ([ADR 553](553-non-destructive-refresh.md)). A text value is written to the first
placeholder field with that key (`packages/data-bundle/src/session.ts:633-637`). An image
value is captured only when the reference is a URI or a path, and a `Leave` visibility is
not captured (`data-js/src/core.rs:1076-1106`).

Data sets are the part of the payload that grows with the record count. In the editor the
payload is not written into the document ([ADR 552](552-binding-is-a-recipe.md)), so
captured data sets last for the session; the XML export is the way to keep them. Export
saves a file on a host with `shell.saveFile@1` and otherwise shows the XML in the panel;
import needs `shell.pickFile@1` (`packages/data-bundle/src/panels/dataset-panel.tsx:201-237`).
The codec depends on `quick-xml` 0.41 with default features off (`Cargo.toml:46-49`).

## Related

- [ADR 552](552-binding-is-a-recipe.md) — the payload that carries the variable set
- [ADR 553](553-non-destructive-refresh.md) — `Overridden` and what it protects
- [ADR 551](551-compiled-to-native-content.md) — the mutations a data set is applied with
- [ADR 315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) — why graph data is not resolved through another plugin


## Amendment, 2026-10-06 (proposed ADR 558)

On branch `om/universal-binding`, a data set also captures and applies every
`Binding::Property` (variable trait `property`, value `DataSetValue::Property`), which makes a
data set range over any property `host.objects` exposes. The Illustrator library does not
carry property variables (its deviation 3). Effective when ADR 558 is accepted.
