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
