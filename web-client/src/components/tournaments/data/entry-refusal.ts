import { z } from 'zod'

import { ApiError } from '@/api/client'

/**
 * How a refused entry (`POST …/entries`) is read and reported — ADR-0968.
 *
 * Every refusal the entry endpoint answers with is a **409** whose body is
 * `{"detail": {"code": "<code>", "message": "<sentence>"}}` (the shape
 * `sessions.py` already sends, and the one `ApiError.body` already retains). The
 * **code** is the contract; the **message** is prose.
 *
 * So the client switches on the code and **owns its own copy** for every code it
 * knows — `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never reach the
 * UI."* Rewording a server sentence can no longer change which notice a player
 * sees, which is exactly what it used to do: the old `entryConflict` compared
 * `error.detail` byte-for-byte against `'You have already entered this event.'`
 * and read **every other 409 as "registration closed"** — a fall-through that
 * stopped being fail-safe the moment a third refusal existed (a *full* event on a
 * *published* tournament would have been reported as a shut window).
 *
 * The server's `message` survives as the fallback for a code we do NOT know (see
 * `entryRefusalNotice` → `null`): report the server's own words rather than invent
 * a headline.
 */

/** The refusal codes this client has copy for — the wire values of the API's
 * `EntryRefusal` (`api/app/tournament_entry_refusals.py`).
 *
 * The tuple is the single source of both the type and the copy table below, so a
 * new refusal (#783's `event_full` and `rating_ineligible`; #784's next ones) is
 * **one entry here and one row there** — and forgetting the row is a compile
 * error, never a silent misclassification. A code that is *not* in this tuple
 * fails the parse and takes the honest-degrade path. */
export const ENTRY_REFUSAL_CODES = [
  'already_entered',
  'registration_closed',
  // #783's two. They are ALSO the `state` tags of the event's `entry_state`
  // (`EventEntryState` in `./types`) — the same refusal, learned on page load
  // instead of from a 409 — which is why the card reads its copy out of the table
  // below rather than carrying words of its own. See `entryControlState`.
  'event_full',
  'rating_ineligible',
] as const

export type EntryRefusalCode = (typeof ENTRY_REFUSAL_CODES)[number]

/** The 409 body, parsed rather than cast (`.claude/rules/parse-at-boundaries.md`):
 * an error body is untrusted input like any other. `message` is deliberately NOT
 * read here — a code we recognise is a code we have words for, so the server's
 * sentence is not part of what we keep. */
const entryRefusalBodySchema = z.object({
  detail: z.object({ code: z.enum(ENTRY_REFUSAL_CODES) }),
})

/** What a refusal looks like to the player. `tone` is a sum type, not a
 * `boolean isError`: the refusals are opposite *news*, and which toast they ring
 * is a property of the refusal, not of the call site.
 *
 * The two fields are **surface-neutral** on purpose, because two surfaces read
 * them: a toast (title + description) when the refusal arrives as a 409, and the
 * event card's `LeadReason` (lead + reason) when the *same* refusal arrives on
 * the page load as `entry_state` (#783). `title` is the state in a few words;
 * `description` is why. Copy that only works shouted in a toast would read wrong
 * on the card, and vice versa — but one refusal must not be worded two ways. */
export interface EntryRefusalNotice {
  tone: 'info' | 'error'
  title: string
  description: string
}

/** The client's copy, one row per code it knows. */
export const ENTRY_REFUSAL_NOTICE: Record<EntryRefusalCode, EntryRefusalNotice> =
  {
    // Benign: it means the player IS in. The tournament is re-read on every settle,
    // so the card behind this note already says "Withdraw" — shouting a red error
    // over it would be the lie.
    already_entered: {
      tone: 'info',
      title: 'You were already entered in this event',
      description: "We've refreshed it with the latest entries.",
    },
    // A genuine refusal: the window is shut (ADR-0017 — the tournament's status IS
    // its registration window), the player is NOT entered and, from this page,
    // cannot be. The classic stale tab: the director moved the tournament on while
    // this page still showed **Enter**. The same settle-reconcile swaps that button
    // for the lock, and the refreshed card is what names the status — this notice
    // does not have to.
    registration_closed: {
      tone: 'error',
      title: 'Entries are closed for this event',
      description:
        "This tournament's registration window is shut. We've refreshed it with the latest status.",
    },
    // The event is at `max_players` (ADR-0783 §4). A fact about the EVENT, not
    // about the player — so it is worded as one. Transient: a withdrawal frees a
    // place, which is why the server refuses it with a 409 and not a 403.
    //
    // These words are read TWICE — as the toast for a 409, and as the card's
    // lead+reason when the same fact arrives as `entry_state` on page load — which
    // is the whole reason this table is shared (ADR-0968: "the client owns its own
    // copy"; two tables would drift).
    event_full: {
      tone: 'error',
      title: 'Event full',
      description: 'Every place in this event has been taken.',
    },
    // The player's rating on the tournament's ladder fails one of the event's
    // rules. This is the GENERIC wording — all a 409 carries is the code. Where the
    // client holds the facts (the card does: `entry_state` names the rule and the
    // rating), it says which rule and what rating, out of the event's own
    // predicates — see `ineligibleReason` in `./lifecycle`.
    rating_ineligible: {
      tone: 'error',
      title: 'Not eligible',
      description: "Your rating doesn't meet this event's eligibility rules.",
    },
  }

/** The code of a refusal we recognise — or `null` for anything else: a 400, a 403,
 * a 5xx, a network failure, **and** a 409 carrying a code this client has no copy
 * for. All of them are the caller's ordinary error path, which surfaces the
 * server's own message. */
export function entryRefusalCode(error: unknown): EntryRefusalCode | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const parsed = entryRefusalBodySchema.safeParse(error.body)
  return parsed.success ? parsed.data.detail.code : null
}

/** The notice to show for a refusal — or `null` when this is not a refusal this
 * client knows how to word, so the caller falls back to the server's sentence. */
export function entryRefusalNotice(error: unknown): EntryRefusalNotice | null {
  const code = entryRefusalCode(error)
  return code === null ? null : ENTRY_REFUSAL_NOTICE[code]
}
