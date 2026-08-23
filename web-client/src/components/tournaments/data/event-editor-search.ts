import { z } from 'zod'

/** The `?event=` value that names the UNSAVED editor — an event that does not exist
 * yet, so it has no uuid to be named by. One constant, because the route parses the
 * param, the page resolves it, and the specs deep-link with it. */
export const NEW_EVENT_PARAM = 'new'

/**
 * **Which event's editor is open lives in the URL** (#1503), so browser Back
 * dismisses the sheet instead of leaving the page, and a link to an open editor is
 * shareable and survives a reload.
 *
 * The route parses this at its boundary, the way `params.parse` parses the tournament
 * id (`.claude/rules/parse-at-boundaries.md`) — but the failure is handled
 * differently, and deliberately so. A malformed *id* names no tournament, which is a
 * not-found (ADR-1001). A malformed `?event=` names no editor, which is not a page
 * state at all: `.catch(undefined)` drops it, the editor stays closed, the tournament
 * renders exactly as it does without the param, and nothing is requested. A garbage
 * query string must never break a page whose resource is perfectly fine.
 *
 * Resolving a well-formed uuid to an event of THIS tournament happens later, in the
 * page, which is the first place that holds the tournament. A uuid naming an event on
 * some other tournament leaves the editor closed for the same reason.
 *
 * It lives in `data/` rather than in the route module because the page imports it
 * too, and the route imports the page — the same arrangement `matchesSearchSchema`
 * has with `/_app/matches/`.
 */
export const eventEditorSearchSchema = z
  .object({
    event: z.union([z.string().uuid(), z.literal(NEW_EVENT_PARAM)]),
  })
  .partial()
  // `.catch({})` on the OBJECT, never `.catch(undefined)` on the field. A field-level
  // catch always produces the key, so a tournament with no editor open would carry
  // `{ event: undefined }` — a search record with a phantom entry in it, which
  // everything that walks the record (the router devtools' explorer, for one) then
  // renders. `{}` is what "no editor is open" actually is.
  .catch({})

/** The `?event=` value, parsed. `undefined` is "no editor open". */
export type EventEditorSearch = z.infer<typeof eventEditorSearchSchema>['event']
