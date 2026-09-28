import userEvent from '@testing-library/user-event'
import { waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { buildOpenCheckoutRead } from '@/mocks/factories/checkouts/open-checkout.factory'
import { mockUuid } from '@/mocks/mock-uuid'
import { screen, within } from '@/test/utilities'

import { mockOpenCheckouts, openCheckoutBarPage as page } from './open-checkout-bar.page'

const TOURNAMENT_ID = mockUuid('bar-spring-open')

describe('OpenCheckoutBar', () => {
  it('shows an active hold with its time left and a way back to it', async () => {
    mockOpenCheckouts([
      buildOpenCheckoutRead({
        tournament_id: TOURNAMENT_ID,
        tournament_name: 'Spring Open',
        expires_at: new Date(Date.now() + 4 * 60_000 + 29_800).toISOString(),
      }),
    ])

    page.render()

    const summary = await page.findSummary()
    expect(summary).toHaveTextContent(/^Checkout open · Spring Open · 04:(30|29) left$/)
    const resume = within(await page.findBar()).getByRole('link', { name: /Resume/ })
    expect(resume).toHaveAttribute(
      'href',
      `/tournaments/${TOURNAMENT_ID}?tab=events&checkout=${mockUuid('open-checkout')}`,
    )
  })

  it('shows a payment under check with no countdown, and a way to view it', async () => {
    mockOpenCheckouts([
      buildOpenCheckoutRead({
        checkout_id: mockUuid('bar-checking-past-deadline'),
        tournament_id: TOURNAMENT_ID,
        tournament_name: 'Spring Open',
        // Past its deadline: a checking payment stays open until it resolves.
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        payment_state: 'checking',
      }),
    ])

    page.render()

    expect(await page.findSummary()).toHaveTextContent(
      /^Checking your payment · Spring Open$/,
    )
    const view = within(await page.findBar()).getByRole('link', { name: /View/ })
    // The checkout id rides along: past its deadline, the Events tab would not
    // otherwise find this checkout, and the player could not watch the payment.
    expect(view).toHaveAttribute(
      'href',
      `/tournaments/${TOURNAMENT_ID}?tab=events&checkout=${mockUuid('bar-checking-past-deadline')}`,
    )
  })

  it('leads with the nearest deadline and lists the rest behind “+N more”', async () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000 - 200).toISOString()
    mockOpenCheckouts([
      buildOpenCheckoutRead({
        checkout_id: mockUuid('bar-checking'),
        tournament_id: mockUuid('bar-autumn-classic'),
        tournament_name: 'Autumn Classic',
        expires_at: minutes(-2),
        payment_state: 'checking',
      }),
      buildOpenCheckoutRead({
        checkout_id: mockUuid('bar-later'),
        tournament_id: mockUuid('bar-winter-cup'),
        tournament_name: 'Winter Cup',
        expires_at: minutes(9),
      }),
      buildOpenCheckoutRead({
        checkout_id: mockUuid('bar-sooner'),
        tournament_id: TOURNAMENT_ID,
        tournament_name: 'Spring Open',
        expires_at: minutes(3),
      }),
    ])
    const user = userEvent.setup()

    page.render()

    expect(await page.findSummary()).toHaveTextContent(
      /^Checkout open · Spring Open · 0[23]:\d\d left$/,
    )
    await user.click(
      within(await page.findBar()).getByRole('button', { name: '+2 more' }),
    )
    const list = screen.getByRole('list', { name: 'All open checkouts' })
    const links = within(list).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Spring Open', `/tournaments/${TOURNAMENT_ID}?tab=events&checkout=${mockUuid('bar-sooner')}`],
      ['Winter Cup', `/tournaments/${mockUuid('bar-winter-cup')}?tab=events&checkout=${mockUuid('bar-later')}`],
      [
        'Autumn Classic',
        `/tournaments/${mockUuid('bar-autumn-classic')}?tab=events&checkout=${mockUuid('bar-checking')}`,
      ],
    ])
  })

  it('shows nothing when no checkout is open', async () => {
    const served = mockOpenCheckouts([])

    page.render()

    await waitFor(() => expect(served.count).toBe(1))
    expect(page.queryBar()).not.toBeInTheDocument()
  })

  it.each([
    ['with no tab named', `/tournaments/${TOURNAMENT_ID}`],
    ['with the Events tab named', `/tournaments/${TOURNAMENT_ID}?tab=events`],
  ])('hides on that tournament’s own Events tab, %s', async (_label, path) => {
    const served = mockOpenCheckouts([
      buildOpenCheckoutRead({ tournament_id: TOURNAMENT_ID }),
    ])

    page.render(path)

    await waitFor(() => expect(served.count).toBe(1))
    expect(page.queryBar()).not.toBeInTheDocument()
  })

  it('still shows on another tournament’s page', async () => {
    mockOpenCheckouts([buildOpenCheckoutRead({ tournament_id: TOURNAMENT_ID })])

    page.render(`/tournaments/${mockUuid('bar-another-tournament')}`)

    expect(await page.findSummary()).toHaveTextContent(/Spring Open/)
  })

  it('refetches once when a hold’s countdown reaches zero, and hides when it has ended', async () => {
    const served = mockOpenCheckouts(
      [buildOpenCheckoutRead({ expires_at: new Date(Date.now() + 1_200).toISOString() })],
      [],
    )

    page.render()

    expect(await page.findSummary()).toHaveTextContent(/Spring Open/)
    await waitFor(() => expect(page.queryBar()).not.toBeInTheDocument(), {
      timeout: 4_000,
    })
    expect(served.count).toBe(2)
  })
})
