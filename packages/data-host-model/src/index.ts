// @paged-media/data-host-model — the pure LoweredOutput → Mutation[] translator
// (spec §9). ZERO binding/expression/sync semantics: those live in the Rust
// engine (data-* crates → data-js wasm). This package is data-in, mutations-out.

export type {
  ContentBox,
  GridRule,
  ImageReference,
  ImageStatus,
  LoweredBarcode,
  LoweredColumn,
  LoweredImage,
  LoweredOutput,
  LoweredRow,
  LoweredTable,
  LoweredVariable,
} from "./lowered";

export {
  barcodeToMutations,
  barcodeModuleCount,
  type BarcodeModule,
  type BarcodePlacement,
} from "./barcode";

export {
  BINDING_KEY,
  BINDING_VERSION,
  makeEnvelope,
  parseEnvelope,
  type BindingEnvelope,
} from "./binding";

export { DEFAULT_INSET_PT, defaultPlacement, type Placement } from "./placement";

export {
  bindingMetadata,
  tableToMutations,
  tableInsertSpec,
  tableInsertMutation,
  tableCellInserts,
  type TableInsertSpec,
  type TableLowerResult,
} from "./lower-to-mutations";

export {
  FIELD_PLUGIN,
  insertFieldMutation,
  setFieldValueMutation,
  diffFields,
  ownFields,
  idmlFit,
  placeableUri,
  placeImageMutation,
  ruleMutations,
  createRuleCellStyle,
  type PlaceholderField,
  type FieldRefresh,
  type IdmlFit,
  type RuleTarget,
} from "./fields";

export { toRuleApplication, type RuleResult, type RuleApplication } from "./rule";
