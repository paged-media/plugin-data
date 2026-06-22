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

// The binding-payload envelope. Binding definitions + source manifests are the
// plugin's document-scoped payload (spec §5.1), stamped via setPluginMetadata
// under this plugin's namespace and round-tripped with the document. The
// envelope is versioned so a future schema can migrate. (The size cap is a
// known SDK gap — BREAKAGE D-08.)

export const BINDING_KEY = "x-paged:media.paged.data";
export const BINDING_VERSION = 1;

/** A versioned wrapper around the binding recipe stored on an element. The
 *  host's setPluginMetadata door VALIDATES the envelope shape: it must be
 *  `{ v: <int >= 1>, data: {…}, engine?: {…} }`. The recipe therefore lives
 *  under `data` (NOT `payload`) — a `{v, payload}` envelope is rejected by the
 *  engine and sinks the whole atomic batch (the barcode-lower regression). */
export interface BindingEnvelope {
  v: number;
  data: unknown;
}

/** Serialise a recipe into the envelope JSON the metadata door carries. The
 *  recipe is stored under `data` to satisfy the host's metadata-envelope
 *  contract (`{ v, data, engine? }`). */
export function makeEnvelope(payload: unknown): string {
  return JSON.stringify({ v: BINDING_VERSION, data: payload } satisfies BindingEnvelope);
}

/** Parse an envelope JSON, returning `null` on anything malformed (the panel
 *  shows a diagnostic rather than throwing). */
export function parseEnvelope(json: string): BindingEnvelope | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { v?: unknown }).v === "number"
    ) {
      return parsed as BindingEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}
