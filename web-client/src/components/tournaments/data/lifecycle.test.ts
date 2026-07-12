import { describe, expect, it } from 'vitest'

import { hasLifecycleAction, LIFECYCLE_EDGE } from './lifecycle'
import { buildTournament } from './seed.factory'

describe('LIFECYCLE_EDGE', () => {
  // The three edges the server's `LEGAL_TRANSITIONS` holds, and nothing else. A
  // fourth entry here would be a button the API can only ever refuse.
  it('offers exactly the forward edges the server allows', () => {
    expect(LIFECYCLE_EDGE.draft?.to).toBe('published')
    expect(LIFECYCLE_EDGE.published?.to).toBe('live')
    expect(LIFECYCLE_EDGE.live?.to).toBe('archived')
  })

  // Terminal: there is no edge out of `archived`, so there is no button — not a
  // disabled one, and certainly not one that walks the lifecycle backwards.
  it('offers no edge out of the terminal archived status', () => {
    expect(LIFECYCLE_EDGE.archived).toBeNull()
  })
})

describe('hasLifecycleAction', () => {
  // What the header asks BEFORE it renders its action slot, so a viewer (and an
  // archived tournament) leaves that slot genuinely empty rather than filling it
  // with a wrapper around a component that renders nothing.
  it.each([
    { status: 'draft', canEdit: true, expected: true },
    { status: 'published', canEdit: true, expected: true },
    { status: 'live', canEdit: true, expected: true },
    { status: 'archived', canEdit: true, expected: false },
    { status: 'draft', canEdit: false, expected: false },
    { status: 'published', canEdit: false, expected: false },
    { status: 'live', canEdit: false, expected: false },
    { status: 'archived', canEdit: false, expected: false },
  ] as const)(
    'is $expected for a $status tournament with canEdit=$canEdit',
    ({ status, canEdit, expected }) => {
      expect(hasLifecycleAction(buildTournament({ status, canEdit }))).toBe(
        expected,
      )
    },
  )
})
