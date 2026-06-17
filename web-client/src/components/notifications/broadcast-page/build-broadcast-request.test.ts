import {
  buildBroadcastRequest,
  canSendBroadcast,
  type BroadcastDraft,
} from './build-broadcast-request'

const draft = (overrides: Partial<BroadcastDraft> = {}): BroadcastDraft => ({
  audience: 'all',
  selectedIds: new Set(),
  channels: new Set(['in_app']),
  title: 'Spring Open is live',
  body: 'Brackets dropped.',
  ...overrides,
})

describe('canSendBroadcast', () => {
  it('is true for an "all" broadcast with a channel and a title', () => {
    expect(canSendBroadcast(draft())).toBe(true)
  })

  it('is false without a channel', () => {
    expect(canSendBroadcast(draft({ channels: new Set() }))).toBe(false)
  })

  it('is false without a title', () => {
    expect(canSendBroadcast(draft({ title: '   ' }))).toBe(false)
  })

  it('is false for a "selected" audience with nobody picked', () => {
    expect(
      canSendBroadcast(draft({ audience: 'selected', selectedIds: new Set() })),
    ).toBe(false)
  })

  it('is true once a recipient is picked', () => {
    expect(
      canSendBroadcast(
        draft({ audience: 'selected', selectedIds: new Set(['u1']) }),
      ),
    ).toBe(true)
  })
})

describe('buildBroadcastRequest', () => {
  it('sends mode "all" for everyone', () => {
    const req = buildBroadcastRequest(draft())
    expect(req.recipients).toEqual({ mode: 'all' })
  })

  it('sends the picked ids for a selected audience', () => {
    const req = buildBroadcastRequest(
      draft({ audience: 'selected', selectedIds: new Set(['u2', 'u1']) }),
    )
    expect(req.recipients).toEqual({
      mode: 'selected',
      user_ids: ['u2', 'u1'],
    })
  })

  it('emits channels in canonical order regardless of selection order', () => {
    const req = buildBroadcastRequest(
      draft({ channels: new Set(['email', 'in_app', 'push']) }),
    )
    expect(req.channels).toEqual(['in_app', 'push', 'email'])
  })

  it('trims the title and body', () => {
    const req = buildBroadcastRequest(
      draft({ title: '  Heads up  ', body: '  Be early.  ' }),
    )
    expect(req.title).toBe('Heads up')
    expect(req.body).toBe('Be early.')
  })
})
