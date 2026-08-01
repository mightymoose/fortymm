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

import type { components } from '@/api/schema'

/** The draw-type keys **this client understands** — the ONE declaration of the
 * vocabulary, and the only list of slugs left on the client. The Zod schema, the
 * `DrawType` union and the catalogue parser's filter are all derived from it below
 * (the `data/solve.ts` shape), so there is nothing here for a second copy to drift
 * against.
 *
 * This is a *vocabulary*, not a menu: it says which keys this build can put in a
 * `TournamentEvent.drawType` and send back as `draw_type`, and nothing about which of
 * them a director is offered — that is the served catalogue's job, and only its job.
 *
 * `satisfies` pins it to the generated enum, so a slug the API does not hold is a
 * compile error here; `draw-types.test.ts` pins the other direction (a member of the
 * API's enum *missing* from this array is a compile failure there), so the two
 * cannot drift apart.
 *
 * ⚠️ **This list is the one client edit a new draw type needs that nothing shouts
 * about.** The catalogue parser below *filters* the served rows against it, silently —
 * so a slug the server seeds and this array omits does not error, warn or log: the
 * option simply is not on the menu. That is exactly how `rr-then-ko` was predicted to
 * need "no client change" and would instead have vanished (ADR "rr-then-ko cuts both
 * stages upfront and seeds qualifiers rematch-free", Context). Adding the slug here is
 * step one of adding a draw type to this client; the compiler will find the rest. */
export const DRAW_TYPES = [
  'round-robin',
  'single-elim',
  'rr-then-ko',
] as const satisfies readonly components['schemas']['DrawType'][]

/** The runtime parser for a single draw-type slug — what the event form validates
 * `drawType` with, so the form cannot accept a slug the catalogue parser would drop. */
export const drawTypeSchema = z.enum(DRAW_TYPES)

/** The draw types the API accepts — deliberately not a roadmap (ADR 20260726 "a draw
 * type is a seeded row"): a member exists iff the server has a strategy that can plan
 * it. `double-elim` and `swiss` were removed from the API's enum and are a 422 at the
 * boundary now; `rr-then-ko` came back in #1227 when its strategy landed.
 *
 * Inferred from `DRAW_TYPES` above rather than hand-written, and pinned to the
 * generated `components['schemas']['DrawType']` by a compile-time assertion in
 * `data/draw-types.test.ts` — so this cannot drift back into offering a director
 * something the server would refuse. Re-exported from `./types` for the domain
 * modules that read every tournament type from there. */
export type DrawType = z.infer<typeof drawTypeSchema>

/** One selectable draw format, **as the server sent it** — a `draw_types` row
 * (`DrawTypeRead`) reduced to what a picker needs (ADR 20260726). `value` is the slug
 * an event stores and sends as its `draw_type`; `label` is the server's own `name`, the
 * only copy for it that exists anywhere.
 *
 * Shaped `value`/`label` rather than the wire's `key`/`name` so it *is* an option list:
 * `labelFor` (`./options`) reads it, and `OptionSelect` renders it, exactly as they do
 * the format and match-length lists. The client no longer authors one of these — they
 * are parsed out of the tournament-detail payload by the parser below. */
export interface DrawTypeOption {
  value: DrawType
  label: string
}

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
