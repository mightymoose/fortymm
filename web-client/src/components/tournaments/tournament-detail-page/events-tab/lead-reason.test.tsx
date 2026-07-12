import { describe, expect, it } from 'vitest'

import { leadReasonPage as page } from './lead-reason.page'

describe('LeadReason', () => {
  it('says the state and then why', () => {
    page.render({
      lead: 'Entries locked',
      reason: 'The tournament is under way.',
    })

    const notice = page.getNotice()
    expect(notice).toHaveTextContent('Entries locked')
    expect(notice).toHaveTextContent('The tournament is under way.')
  })

  // The reason for this component's existence, and for its being a `<p>`: a state
  // the reader cannot act on is inert text, never a disabled control (ADR 0015 —
  // "hide mutating affordances, never disable them"). All three call sites render
  // it where a button would otherwise sit, so this is the guard for all three.
  it('renders no interactive control — a reason is not a dead-end button', () => {
    page.render()

    expect(page.getControls()).toHaveLength(0)
  })

  it('keeps the lead and the reason one readable sentence when inline', () => {
    page.render({
      lead: 'No one has entered yet.',
      reason: 'Players who enter this event will be listed here.',
      layout: 'inline',
    })

    // The space matters: without it the roster's two sentences would run together
    // as "…yet.Players who…".
    expect(page.getNotice()).toHaveTextContent(
      'No one has entered yet. Players who enter this event will be listed here.',
    )
  })
})
