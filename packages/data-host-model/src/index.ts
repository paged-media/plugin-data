// @paged-media/data-host-model — the pure LoweredOutput → Mutation[] translator
// (spec §9). ZERO binding/expression/sync semantics: those live in the Rust
// engine (data-* crates → data-js wasm). This package is data-in, mutations-out.

export type {
  ContentBox,
  GridRule,
  LoweredColumn,
  LoweredOutput,
  LoweredRow,
  LoweredTable,
  LoweredVariable,
} from "./lowered";

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
  type TableLowerResult,
} from "./lower-to-mutations";
