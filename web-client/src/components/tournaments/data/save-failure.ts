// Why a save was refused, in **our** words — #783 QA, round two.
//
// The editor's refusal banner used to print `ApiError.detail` for any 4xx, and the
// "New tournament" dialog did the same thing on its name field. For a 422 that string
// is **Pydantic's**, not ours:
//
//     "String should have at most 255 characters"
//     "String should have at least 1 character"
//
// — the wire's vocabulary ("String"), a constraint rather than an instruction, and no
// clue as to *which* field it is about. It is exactly what `DEFINITION_OF_COMPLETE.md`
// forbids ("Raw API detail strings never reach the UI") and what ADR-0968 settled for
// the entry refusals: **the client owns its copy; the server's words are a fallback,
// not the UI.**
//
// So the error is classified first and worded second. The classification is a sum
// type, because the four cases are opposite *news* — one is about a field the
// organizer can fix, one is about a refusal the server explained in a sentence *we*
// wrote (a 403, a 409), one is about the network, one is about nothing we can name —
// and a `string | null` cannot tell them apart, which is precisely how Pydantic's
// prose ended up on screen.
//
// **One classifier, one copy table, both dialogs.** The event sheet and the
// new-tournament dialog fail the same way against the same API, so neither owns a
// wording of it: two tables for one job drift, and a drifted table is exactly how a
// fix ships in one dialog and not in its sibling. What differs between them is only
// *data* — the noun for the thing being saved, and the labels the form prints above
// its rows — so that is what a caller passes in (`SaveTarget`); the sentences live
// here, once.

import { validationFields, ApiError, extractDetail } from '@/api/client'

/**
 * What happened when the save was refused.
 *
 * `invalid` is the 422 — and note it is chosen by the **shape** of the body
 * (`validationFields` returns non-`null` only for FastAPI's per-field error array),
 * not merely by the status: that array is the one error body whose message is
 * machine prose, so it is the one whose message we never show. What we keep from it
 * is the thing we could not have guessed: which fields it named.
 */
export type SaveFailure =
  /** A 422: the request carried something the server would not accept. `fields` are
   * the wire names it blamed (`name`, `max_players`, …) — possibly empty, when it
   * named nothing a form row maps to. */
  | { kind: 'invalid'; fields: string[] }
  /** A 4xx the server explained in a sentence **we** wrote (`{"detail": "You can
   * only modify tournaments you created."}`) — the ADR-0968 fallback: for a refusal
   * the client cannot name, report the server's own words rather than invent a
   * headline. */
  | { kind: 'refused'; message: string }
  /** A 5xx, or no response at all. Nothing to do with what they typed. */
  | { kind: 'unreachable' }
  /** Not an `ApiError` — a bug on our side of the fetch. */
  | { kind: 'unknown' }

/**
 * The *data* a form brings to the shared copy below: what it is saving, and what it
 * calls the fields the server might blame.
 *
 * The label keys are the API's (`TournamentEventCreate`, `TournamentCreate`), because
 * that is what a `loc` carries; a field NOT in the table is one the form has no row
 * for, and the copy then says so generically rather than naming a box nobody is
 * looking at.
 */
export interface SaveTarget {
  /** The noun the generic sentence uses: "Some of this **event**'s details…". */
  subject: string
  /** Wire field name → the words the form puts above that row. */
  labels: Record<string, string>
}

/** The event editor's fields, in the words its form puts above them. */
export const EVENT_SAVE_TARGET: SaveTarget = {
  subject: 'event',
  labels: {
    name: 'Event name',
    format: 'Format',
    draw_type: 'Draw type',
    max_players: 'Player limit',
    entry_fee: 'Entry fee',
    slot: 'Time slot',
    match_settings: 'Match settings',
    predicates: 'Eligibility rules',
    pools: 'Table pools',
  },
}

/**
 * The "New tournament" dialog's fields (`TournamentCreate`).
 *
 * `address` is one label for five boxes on purpose: the wire nests them
 * (`loc: ["body", "address", "city"]`) and `validationFields` keeps only the first
 * segment, because the leaf is the wire's business. "Venue address" is the block of
 * the form the organizer has to look at, and getting them there is all the sentence
 * has to do.
 *
 * `description` / the dates / `table_catalogue` are here although the dialog shows no
 * box for them: it *sends* them (`draftToCreateBody` fills them from the empty draft),
 * so the server can blame them — and a blamed field with no label falls through to the
 * generic sentence, which would be a worse answer than naming it.
 */
export const TOURNAMENT_SAVE_TARGET: SaveTarget = {
  subject: 'tournament',
  labels: {
    name: 'Name',
    address: 'Venue address',
    description: 'Description',
    start_date: 'Start date',
    end_date: 'End date',
    table_catalogue: 'Tables',
  },
}

/** Classify a rejected save. Nothing here reads a server *message* except the one
 * arm that is allowed to (`refused`). */
export function saveFailure(error: unknown): SaveFailure {
  if (!(error instanceof ApiError)) return { kind: 'unknown' }

  // Pydantic's array body — whatever status it arrives under. Its `msg` is
  // machinery; its `loc` is the only part worth keeping.
  const fields = validationFields(error)
  if (fields) return { kind: 'invalid', fields }

  // A 422 that is NOT that array is one of *our* `HTTPException`s. It is still a
  // rejected field, and it is still not copy this banner will read out: the client
  // owns the wording for "we sent something the server won't take".
  if (error.status === 422) return { kind: 'invalid', fields: [] }

  if (error.status === 0 || error.status >= 500) return { kind: 'unreachable' }

  const message = extractDetail(error.body)
  return message ? { kind: 'refused', message } : { kind: 'unknown' }
}

/** The blamed fields this form has a label for, in the words above its rows — dropping
 * the ones it has none for, since a field the form never shows cannot be pointed at.
 * Empty for every failure that is not a 422. */
function refusedLabels(failure: SaveFailure, target: SaveTarget): string[] {
  if (failure.kind !== 'invalid') return []
  return failure.fields
    .map((field) => target.labels[field])
    .filter((label): label is string => label !== undefined)
}

/** Join field labels the way a sentence does: "the Event name and the Player limit". */
function list(labels: string[]): string {
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * What the organizer is told. Every sentence here is the client's — the only one
 * that is not is the `refused` arm's, which is a sentence the API *wrote for a
 * human* (ADR-0968's last-resort fallback), never a validator's.
 *
 * The event editor's banner appends its own "Nothing was saved — your changes are
 * still here.", so none of these repeat it.
 */
export function saveFailureMessage(
  failure: SaveFailure,
  target: SaveTarget,
): string {
  switch (failure.kind) {
    case 'invalid': {
      const labels = refusedLabels(failure, target)
      if (labels.length === 0) {
        // A 422 naming nothing the form has a row for. Still ours to word: the one
        // thing we know is that something in this draft is not acceptable.
        return `Some of this ${target.subject}'s details were rejected. Check the fields and try again.`
      }
      return `The ${list(labels)} ${
        labels.length === 1 ? 'was' : 'were'
      } rejected. Check ${labels.length === 1 ? 'that field' : 'those fields'} and try again.`
    }
    case 'refused':
      return failure.message
    case 'unreachable':
      return "The server couldn't be reached. Check your connection and try again."
    case 'unknown':
      return 'Something went wrong. Try again.'
  }
}
