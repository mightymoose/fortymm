import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildPlayerApiError } from './player-route-error.factory'
import { playerRouteErrorPage } from './player-route-error.page'

const page = playerRouteErrorPage

describe('PlayerRouteError', () => {
  it('renders the designed page-level error state — eyebrow, headline, one sentence', async () => {
    page.render()

    expect(await page.findAlert()).toBeInTheDocument()
    // The eyebrow names the *class* of failure, and it is not "404": that is the
    // not-found state's eyebrow, and putting it above a 500 would be a lie.
    expect(page.getEyebrow()).toBeInTheDocument()
    expect(page.getHeadline()).toHaveTextContent('Couldn’t load this player.')
    expect(page.getBody(/something went wrong reaching the server/i)).toBeInTheDocument()
  })

  it('paints with styling that actually applies on this route', async () => {
    // #1001, the half that is not a 404. This boundary used to reach for
    // `.empty` / `.empty-title` / `.empty-sub` / `.empty-clear`, which are
    // declared ONLY under a `.match-list-page` ancestor. The player routes have
    // no such ancestor, so every one of those selectors matched nothing and the
    // error state painted as naked, unpadded text flush against the sidebar —
    // exactly the complaint the ticket was filed about.
    //
    // What it paints with now is `md-error-state`, declared in `src/index.css`
    // under `.fortymm-theme`, which sits on `<body>` — so it applies anywhere in
    // the app. It is the same treatment `AppError` and the match-details boundary
    // use, and the same "Error and Empty States" language as `NotFoundContent`
    // beside it.
    //
    // jsdom loads no stylesheets, so this asserts the *class contract* rather
    // than computed padding; the browser check is the e2e suite's. It still
    // discriminates: revert the component and it goes red on both halves.
    page.render()
    await page.findAlert()

    expect(page.getStyledBlock()).toBe(page.getAlert())
    expect(page.getDeadStyleNodes()).toHaveLength(0)
  })

  it('offers exactly one way out, and it is a working Try again', async () => {
    const user = userEvent.setup()
    const reset = vi.fn()
    page.render({ reset })
    await page.findAlert()

    const actions = page.getActions()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toHaveAccessibleName('Try again')

    await user.click(page.getRetry())

    // The boundary is reset; the router invalidation that refetches the profile
    // is proven end-to-end by the route tests (a request that fails once, a
    // click, and the profile paints).
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a broken server', buildPlayerApiError(500)],
    ['an ordinary 401', buildPlayerApiError(401)],
    ['a 403 refusal', buildPlayerApiError(403)],
    ['a dead network', new TypeError('Failed to fetch')],
  ])(
    'gives %s the same retryable state — and never says “Player not found.”',
    async (_label, error) => {
      // ADR-1001 left this boundary ONE branch, always retryable. A 401 or a 403
      // is not a missing player and must never be told it is one — and neither
      // may be left without a way out, which is the dead end #1001 filed.
      page.render({ error })
      await page.findAlert()

      expect(page.getHeadline()).toHaveTextContent('Couldn’t load this player.')
      expect(page.getRetry()).toBeInTheDocument()
      expect(page.getActions()).toHaveLength(1)
      expect(page.getAlert()).not.toHaveTextContent(/player not found/i)
    },
  )

  it('tolerates a non-Error throw without blowing up', async () => {
    // A router `notFound()` is a plain object (`{ isNotFound: true }`), not an
    // `Error`. It should never reach here — `CatchNotFound` is mounted inside
    // `CatchBoundary`, so it catches first — but nothing in this component may
    // dereference the throw and turn a stray one into a white screen.
    page.render({ error: { isNotFound: true } as unknown as Error })

    expect(await page.findAlert()).toBeInTheDocument()
    expect(page.getRetry()).toBeInTheDocument()
  })

  it('renders no <main> landmark of its own — the route already sits inside one', async () => {
    // The same double-shell guard `PlayerNotFound` carries: this replaces the
    // route's component *inside* `_app`, which is an `<AppShell>`. A boundary
    // that wrapped its own shell would put two `<main>`s, two sidebars and two
    // headers on the page.
    page.render()
    await page.findAlert()

    expect(page.getMainLandmarks()).toHaveLength(0)
  })
})
