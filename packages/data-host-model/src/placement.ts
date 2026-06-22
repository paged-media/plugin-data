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

// Where a lowered region lands on the page. Bounds are `[top, left, bottom,
// right]` in page coordinates (the convention the sheet host-model uses); the
// table IR is content-space (offsets from the region's own top-left, §9.6), so
// the translator adds this origin.

import type { PageId } from "@paged-media/plugin-api";

import type { ContentBox } from "./lowered";

/** A page + the page-coordinate bounds a frame is placed at. */
export interface Placement {
  pageId: PageId;
  bounds: [number, number, number, number];
}

/** Default page inset for a freshly-lowered region (pt). */
export const DEFAULT_INSET_PT = 36;

/** A default top-left placement sized to a lowered region's content box. */
export function defaultPlacement(pageId: PageId, bounds: ContentBox): Placement {
  const top = DEFAULT_INSET_PT;
  const left = DEFAULT_INSET_PT;
  return {
    pageId,
    bounds: [top, left, top + bounds.heightPt, left + bounds.widthPt],
  };
}
