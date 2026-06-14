import { buildApiError } from './match-details-error.factory'
import { matchDetailsErrorPage } from './match-details-error.page'

describe('MatchDetailsError', () => {
  it('shows the not-found dead end with a Back to matches link for a 404', async () => {
    matchDetailsErrorPage.render({ error: buildApiError(404, 'Match not found.') })

    await matchDetailsErrorPage.findAlert()
    expect(
      matchDetailsErrorPage.queryMessage(/couldn.t find that match/i),
    ).toBeInTheDocument()
    expect(matchDetailsErrorPage.queryBackLink()).toHaveAttribute(
      'href',
      '/matches',
    )
    // Retrying the same URL won't help — no retry affordance.
    expect(matchDetailsErrorPage.queryRetryButton()).not.toBeInTheDocument()
  })

  it('shows friendly not-found copy without leaking the raw API detail for a malformed id (#152)', async () => {
    matchDetailsErrorPage.render({
      error: buildApiError(
        422,
        'Input should be a valid UUID, invalid character: found `g` at 1',
      ),
    })

    await matchDetailsErrorPage.findAlert()
    expect(
      matchDetailsErrorPage.queryMessage(/couldn.t find that match/i),
    ).toBeInTheDocument()
    // The raw pydantic validation message must not reach the user.
    expect(matchDetailsErrorPage.queryMessage(/valid UUID/i)).not.toBeInTheDocument()
    expect(matchDetailsErrorPage.queryBackLink()).toHaveAttribute(
      'href',
      '/matches',
    )
  })

  it('shows retry guidance (not the not-found dead end) when rate-limited with a 429 (#514)', async () => {
    matchDetailsErrorPage.render({ error: buildApiError(429, 'Too Many Requests') })

    await matchDetailsErrorPage.findAlert()
    // 429 is transient — retry copy, not "couldn't find that match".
    expect(
      matchDetailsErrorPage.queryMessage(/too many requests/i),
    ).toBeInTheDocument()
    expect(
      matchDetailsErrorPage.queryMessage(/couldn.t find that match/i),
    ).not.toBeInTheDocument()
    // Retrying the same URL is the right move, so keep the retry affordance and
    // drop the back-to-list dead end.
    expect(matchDetailsErrorPage.queryRetryButton()).toBeInTheDocument()
    expect(matchDetailsErrorPage.queryBackLink()).not.toBeInTheDocument()
  })

  it('shows a generic retryable error for a 5xx', async () => {
    matchDetailsErrorPage.render({ error: buildApiError(500, 'boom') })

    await matchDetailsErrorPage.findAlert()
    expect(
      matchDetailsErrorPage.queryMessage(/something went wrong loading this match/i),
    ).toBeInTheDocument()
    expect(matchDetailsErrorPage.queryRetryButton()).toBeInTheDocument()
    expect(matchDetailsErrorPage.queryBackLink()).not.toBeInTheDocument()
  })

  it('treats a non-ApiError (network failure) as a generic retryable error', async () => {
    matchDetailsErrorPage.render({ error: new Error('NetworkError') })

    await matchDetailsErrorPage.findAlert()
    expect(
      matchDetailsErrorPage.queryMessage(/something went wrong loading this match/i),
    ).toBeInTheDocument()
    expect(matchDetailsErrorPage.queryRetryButton()).toBeInTheDocument()
  })
})
