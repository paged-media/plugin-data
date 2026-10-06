# InDesign Data Merge oracle fixtures

From the InDesign 2025 (20.0.1.32) round-trip survey of 2026-10-06
(`thoughts`, branch `om/indesign-roundtrip`,
`docs/paged/object-model/indesign-roundtrip/cases-2/`):

- `dm-base.idml` — authored by InDesign itself (`author.jsx`): a text frame
  whose story reads `<<name>>` / `SKU: <<sku>>` as plain text, and a rectangle
  named `card-photo`. No Data Merge yet ("Fehlende Platzhalter" on merge).
- `dm-minimal.idml` — `dm-base` plus ONLY the minimal native Data Merge set
  (`inject.py data_merge(True)`): `<DataMerge>` in Preferences, a
  `HyperlinkTextSource` + `DBF_<field>` destination + `Hyperlink` per text
  field, a `<DataMergeImagePlaceholder>`. InDesign opened it with fields
  `name, sku, photo` and `mergeRecords()` produced the 3 records.

`test/datamerge-template.spec.ts` rewrites `dm-base` with paged.data's
template writer and checks the result is `dm-minimal`, modulo `Self` ids.
