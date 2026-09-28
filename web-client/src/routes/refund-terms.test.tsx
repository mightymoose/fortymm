import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'

import { Route as RefundTermsRoute } from './refund-terms'

const RefundTerms = RefundTermsRoute.options.component!

describe('/refund-terms', () => {
  it('states the refund policy without needing a session', async () => {
    let sessionReads = 0
    server.use(
      http.get('*/v1/session', () => {
        sessionReads += 1
        return HttpResponse.json({}, { status: 500 })
      }),
    )

    renderWithRoutes(<RefundTerms />, { path: '/refund-terms' })

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Refund terms' }),
    ).toBeInTheDocument()
    const policy = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(policy).toEqual([
      'Refunds are full refunds only, per event.',
      'If you withdraw before registration closes, your refund is automatic. After registration closes, the organizer approves the refund.',
      'If an event is cancelled, every paid entry in it is refunded.',
      'You never pay card fees.',
      'A combined payment is refunded one event at a time.',
    ])
    expect(sessionReads).toBe(0)
  })
})
