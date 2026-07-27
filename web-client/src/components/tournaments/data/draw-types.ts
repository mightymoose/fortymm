// The **served** draw-type catalogue: the rows the tournament-detail payload sends
// (`draw_type_catalogue`), parsed at the boundary into the options the picker renders.
//
// There is no hardcoded list of draw types with labels here, and there must never be
// one again (ADR 20260726 "a draw type is a seeded row, and the enum holds only what
// runs"). `DRAW_TYPE_OPTIONS` — five entries, then two, with copy of its own — was the
// second half of a pair that had to agree with the server's seed by hand; the picker
// now renders what it was sent, so a draw type the server does not offer cannot be
// chosen and its label lives in exactly one place (the `draw_types` table).

import { z } from 'zod'

import type { DrawType, DrawTypeOption } from './types'

/** The draw-type keys **this client understands** — the runtime twin of the `DrawType`
 * union, and the only list of slugs left on the client.
 *
 * This is a *vocabulary*, not a menu: it says which keys this build can put in a
 * `TournamentEvent.drawType` and send back as `draw_type`, and nothing about which of
 * them a director is offered — that is the served catalogue's job, and only its job.
 *
 * `satisfies` stops a slug the API's enum does not hold from being added; `draw-types.test.ts`
 * pins the other direction (a member missing here is a compile failure), so the two
 * cannot drift apart. */
export const DRAW_TYPES = [
  'round-robin',
  'single-elim',
] as const satisfies readonly DrawType[]

const KNOWN_KEYS: ReadonlySet<string> = new Set(DRAW_TYPES)

/** One row of `draw_types` as the wire holds it. `key` is deliberately a plain
 * `string` here — an unknown slug is not a malformed row, it is a draw type this build
 * has no word for, and the two are handled differently below. */
const drawTypeRowSchema = z.object({
  key: z.string(),
  name: z.string().trim().min(1),
  display_order: z.number(),
})

type DrawTypeRow = z.infer<typeof drawTypeRowSchema>

const isKnownKey = (row: DrawTypeRow): row is DrawTypeRow & { key: DrawType } =>
  KNOWN_KEYS.has(row.key)

/**
 * PARSED, not cast — the same boundary the fixtures, the results and the solve row
 * cross (`.claude/rules/parse-at-boundaries.md`). This one feeds a **picker**, so a
 * malformed row is worse than a rendering glitch: whatever a director clicks becomes
 * the `draw_type` of a PATCH, so a row that arrives without a `name` (a blank menu
 * item) or without a `key` must fail HERE, inside the `queryFn`, rather than be
 * offered.
 *
 * Three behaviours, each deliberate:
 *
 * - **`null`/absent parses to `null`.** The LIST route withholds the catalogue
 *   (`api/app/tournament_list.py`) because it is page data for the one page that picks
 *   a draw type. `null` therefore means "not sent", which is a different fact from "the
 *   server offers no draw types" and is kept distinct all the way to the surfaces.
 * - **A row whose `key` this build does not know is dropped, not fatal.** A draw type
 *   seeded on the server is meant to reach the picker with no client change — but this
 *   client can only honestly offer a slug its own types admit, since picking one it
 *   cannot hold would author a PATCH its own schema rejects. Dropping degrades to "the
 *   formats this build understands"; throwing would take the whole tournament page down
 *   because the server grew a feature.
 * - **The order is `display_order`'s**, not the array's. The server already sorts, so
 *   this is belt-and-braces — but it makes the column load-bearing rather than
 *   decorative, and it is what a test that reorders the served rows exercises.
 */
const drawTypeCatalogueSchema = z
  .array(drawTypeRowSchema)
  .nullish()
  .transform((rows): DrawTypeOption[] | null =>
    rows == null
      ? null
      : rows
          .filter(isKnownKey)
          .sort((a, b) => a.display_order - b.display_order)
          .map((row) => ({ value: row.key, label: row.name })),
  )

/** Parse a tournament payload's `draw_type_catalogue`. Throws on a malformed
 * catalogue; returns `null` when the payload did not carry one (a list row). */
export function parseDrawTypeCatalogue(raw: unknown): DrawTypeOption[] | null {
  return drawTypeCatalogueSchema.parse(raw)
}
