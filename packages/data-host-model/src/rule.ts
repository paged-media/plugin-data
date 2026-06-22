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

// The data-driven rule IR (D-13, spec §9.5) — the exact shape the `data-js`
// engine serialises from `evaluate_rule` (`RuleResult`), plus a pure mapper to
// the host-model's `RuleApplication`. The engine decided WHICH records fired
// WHICH style (the data-driven half); the host applies the named DOCUMENT style
// (never a parallel styling system, never a color literal — §9.5). Type-only +
// pure; the mutations are shaped in `fields.ts` (`ruleMutations`).

/** The engine's `evaluate_rule` output (`RuleResult`, serde camelCase). `apply`
 *  is a tagged document-style action (`action` discriminant, camelCase
 *  variants). */
export interface RuleResult {
  scope: string;
  /** Stabilized record indices where the `when` condition fired. */
  fires: number[];
  apply:
    | { action: "characterStyle"; name: string }
    | { action: "paragraphStyle"; name: string }
    | { action: "tableStyle"; name: string };
  total: number;
}

/** The host-model's normalised rule application: the fired record indices + the
 *  document-style action collapsed to `{kind, name}` (paragraph/character/table
 *  → the host apply path). */
export interface RuleApplication {
  scope: string;
  fires: number[];
  total: number;
  apply:
    | { kind: "character"; name: string }
    | { kind: "paragraph"; name: string }
    | { kind: "table"; name: string };
}

/** Map the engine's `RuleResult` to the host-model `RuleApplication`. Pure: the
 *  firing decision is the engine's; this only re-labels the style action for the
 *  host apply path (`fields.ts` `ruleMutations`). */
export function toRuleApplication(result: RuleResult): RuleApplication {
  const apply =
    result.apply.action === "characterStyle"
      ? ({ kind: "character", name: result.apply.name } as const)
      : result.apply.action === "paragraphStyle"
        ? ({ kind: "paragraph", name: result.apply.name } as const)
        : ({ kind: "table", name: result.apply.name } as const);
  return { scope: result.scope, fires: result.fires, total: result.total, apply };
}
