// How a refused entry is READ (ADR-0968). The unit under test is the seam that
// used to compare the server's English byte-for-byte and treat every unrecognised
// 409 as a shut registration window.

import { describe, expect, it } from 'vitest'

import { ApiError, extractDetail } from '@/api/client'
import {
  ENTRY_REFUSAL_CODES,
  ENTRY_REFUSAL_NOTICE,
  entryRefusalCode,
  entryRefusalNotice,
} from './entry-refusal'

/** The `ApiError` the client's `unwrap` builds from a 409 — `detail` extracted
 * from the body, and the raw `body` kept, which is where the code lives. */
function refusal(body: unknown, status = 409): ApiError {
  return new ApiError(status, extractDetail(body), 'enter event', body)
}

function coded(code: string, message = 'the server said something') {
  return { detail: { code, message } }
}

describe('entryRefusalCode', () => {
  it.each(ENTRY_REFUSAL_CODES)('reads the %s code off the 409 body', (code) => {
    expect(entryRefusalCode(refusal(coded(code)))).toBe(code)
  })

  // THE property the chore buys. The message is prose, not a contract: reword it,
  // drop the period, add an emoji — the refusal is still the refusal, because the
  // code said so. The old seam read this as a *closed window*, since the sentence
  // no longer matched the one it was compiled against.
  it('does not care what the message says — only what the code says', () => {
    const reworded = coded('already_entered', "You're already in — no need!")

    expect(entryRefusalCode(refusal(reworded))).toBe('already_entered')
  })

  // The fall-through the ADR was written against. `event_full` and
  // `rating_ineligible` have since arrived (#783) and are named below; the refusals
  // that have NOT (#784's director-withdrawal codes, say) must still not be silently
  // classified as one of the four this client does know.
  it('returns null for a code it has no copy for — it does not guess', () => {
    expect(entryRefusalCode(refusal(coded('invitation_only')))).toBeNull()
    expect(entryRefusalCode(refusal(coded('withdrawn_by_director')))).toBeNull()
  })

  // …and the two #783 added ARE named now: same 409 shape, same switch, one more row.
  it.each(['event_full', 'rating_ineligible'] as const)(
    'reads the %s refusal #783 added',
    (code) => {
      expect(entryRefusalCode(refusal(coded(code)))).toBe(code)
    },
  )

  // Defence in depth for a 409 that never went through ADR-0968 (an old server, a
  // proxy's own error page, a shape drift): a body that does not parse is not a
  // refusal we can name.
  it.each([
    { name: 'a bare string detail (the pre-ADR shape)', body: { detail: 'You have already entered this event.' } },
    { name: 'a detail with no code', body: { detail: { message: 'nope' } } },
    { name: 'a non-string code', body: { detail: { code: 7 } } },
    { name: 'no detail at all', body: {} },
    { name: 'no body at all', body: undefined },
    { name: 'a string body', body: 'gateway timeout' },
  ])('returns null for $name', ({ body }) => {
    expect(entryRefusalCode(refusal(body))).toBeNull()
  })

  it.each([400, 403, 404, 422, 500, 0])(
    'returns null for a %s — a refusal is a 409, and everything else is an ordinary error',
    (status) => {
      // Even when the body somehow carries a code we know: the status is part of
      // the contract, and a 500 is not a refusal.
      expect(entryRefusalCode(refusal(coded('already_entered'), status))).toBeNull()
    },
  )

  it('returns null for something that is not an ApiError at all', () => {
    expect(entryRefusalCode(new TypeError('Failed to fetch'))).toBeNull()
    expect(entryRefusalCode(null)).toBeNull()
  })
})

describe('entryRefusalNotice', () => {
  // Opposite news, and the tone is what says so: being already entered means the
  // player IS in (the reconciled card behind the toast says "Withdraw"), while a
  // shut window means they are NOT and cannot be.
  it('is a benign INFO note for already_entered', () => {
    expect(entryRefusalNotice(refusal(coded('already_entered')))).toEqual({
      tone: 'info',
      title: 'You were already entered in this event',
      description: "We've refreshed it with the latest entries.",
    })
  })

  it('is an ERROR for registration_closed', () => {
    expect(entryRefusalNotice(refusal(coded('registration_closed')))).toEqual({
      tone: 'error',
      title: 'Entries are closed for this event',
      description:
        "This tournament's registration window is shut. We've refreshed it with the latest status.",
    })
  })

  // #783's two. These rows are read by BOTH surfaces — the toast a 409 rings, and
  // the event card's lead+reason when the same refusal arrived on the page load as
  // `entry_state` (see `entryControlState`). One refusal, one set of words: if the
  // card ever said "Event full" while the toast said something else, one of them
  // would be wrong and nothing would say which.
  it('is an ERROR for event_full — the same words the card leads with', () => {
    expect(entryRefusalNotice(refusal(coded('event_full')))).toEqual({
      tone: 'error',
      title: 'Event full',
      description: 'Every place in this event has been taken.',
    })
  })

  // A 409 carries only the code — no `predicate_id`, no `rating` — so this is the
  // GENERIC wording. The card, which holds those facts, says which rule and what
  // rating (`entryControlState`); the toast cannot, and does not pretend to.
  it('is a GENERIC error for rating_ineligible — a 409 carries no rule to name', () => {
    expect(entryRefusalNotice(refusal(coded('rating_ineligible')))).toEqual({
      tone: 'error',
      title: 'Not eligible',
      description: "Your rating doesn't meet this event's eligibility rules.",
    })
  })

  it('is null for anything it cannot name — the caller falls back to the server', () => {
    expect(entryRefusalNotice(refusal(coded('invitation_only')))).toBeNull()
  })

  // The copy is the CLIENT's: no notice may be assembled out of whatever prose the
  // server happened to send ("Raw API detail strings never reach the UI").
  it('never quotes the server — a wild message reaches neither line of the notice', () => {
    const wild = 'ERR-4171: entry rejected by tournament_entries_active_uq'

    const notice = entryRefusalNotice(refusal(coded('already_entered', wild)))!

    expect(notice.title).not.toContain(wild)
    expect(notice.description).not.toContain(wild)
  })

  // The table is keyed by the code tuple, so a refusal added in a later chore
  // (`event_full`, `rating_ineligible`) cannot be *listed* without being *worded* —
  // that omission is a type error. This pins the runtime half of the same claim.
  it('has copy for every code it claims to know', () => {
    for (const code of ENTRY_REFUSAL_CODES) {
      const notice = ENTRY_REFUSAL_NOTICE[code]
      expect(notice.title.length).toBeGreaterThan(0)
      expect(notice.description.length).toBeGreaterThan(0)
    }
  })
})
