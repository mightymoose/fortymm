import { describe, expect, it, vi } from 'vitest'

import { render, screen } from '@/test/utilities'

import { MergeGate } from './merge-gate'

const props = {
  ownerUsername: 'brave-otter',
  guestUsername: 'drifting-grouse',
  matchesCount: 2,
  busy: false,
  onBringThemOver: vi.fn(),
  onNotNow: vi.fn(),
}

describe('MergeGate', () => {
  it('tells a first-time signer that accepting keeps the guest name', () => {
    render(<MergeGate {...props} adoptsGuestUsername />)

    // The name promise (G1) is made at the moment the choice is offered, not
    // only after it. Copy that mentions matches alone hides it.
    expect(screen.getByText(/this also keeps your name/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /not now — sign me in as brave-otter/i }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('drifting-grouse').length).toBeGreaterThan(0)
  })

  it('makes no promise about the name on an ordinary merge', () => {
    render(<MergeGate {...props} />)

    // A merge into an established account does not move the username, so the
    // gate must not say it does.
    expect(screen.queryByText(/this also keeps your name/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /not now — just sign me in/i }),
    ).toBeInTheDocument()
  })

  it('makes no name promise when there is no guest name to keep', () => {
    render(<MergeGate {...props} guestUsername={null} adoptsGuestUsername />)

    expect(screen.queryByText(/this also keeps your name/i)).not.toBeInTheDocument()
  })
})
