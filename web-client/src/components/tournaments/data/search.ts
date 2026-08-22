// The tournaments list's URL search state, parsed.
//
// Its own module, imported by BOTH the route (`routes/_app/tournaments/index.tsx`,
// which hands it to `validateSearch`) and the page (`../tournaments-list-page`, which
// reads it back through `useSearch`). Neither imports the other, so there is no
// route → page → route import cycle — the arrangement `matches/match-list-status.ts`
// established one page over.

import { z } from 'zod'

import { TOURNAMENT_STATUS_KEYS } from './options'

/** The URL is a boundary, so a schema parses it (`.claude/rules/parse-at-boundaries.md`).
 *
 * Two deliberate spellings, both copied from `matchesSearchSchema`:
 *
 * - `.trim().min(1)` — `?q=%20%20%20` collapses to no filter rather than persisting
 *   as a whitespace query the user cannot see and cannot clear.
 * - `.optional().catch(undefined)` — an unrecognized value **degrades to the default,
 *   it never throws**. A bookmark carrying `?status=someoldvalue` from before a status
 *   rename renders the All tab, not a route error.
 *
 * `status` is `z.enum(TOURNAMENT_STATUS_KEYS)`, read off the same `Record` the tab strip
 * is built from, NOT a hand-typed `z.enum(['draft', …])`. A re-typed list here would be
 * the very construct #970 exists to delete, one file over: a fifth status would red the
 * tab strip and leave the URL schema quietly green. */
export const tournamentsSearchSchema = z.object({
  q: z.string().trim().min(1).optional().catch(undefined),
  status: z.enum(TOURNAMENT_STATUS_KEYS).optional().catch(undefined),
})

export type TournamentsSearch = z.infer<typeof tournamentsSearchSchema>
