import { buildAgentAccess } from '@/mocks/factories/settings/agent-access.factory'
import {
  claudeAccessLoadFailedView,
  selectClaudeAccess,
} from './claude-access-query'

describe('selectClaudeAccess', () => {
  it('resolves each server state to its own status', () => {
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'guest', email: null }))
        .status,
    ).toEqual({ kind: 'guest' })
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'gated' })).status,
    ).toEqual({ kind: 'gated' })
    // The player's own switch-off, which is NOT `gated` (the operator's) and
    // must not collapse into it: only one of the two has a way back on screen.
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'revoked' })).status,
    ).toEqual({ kind: 'revoked' })
    expect(
      selectClaudeAccess(
        buildAgentAccess({ state: 'ready', email: 'rita@club.tt' }),
      ).status,
    ).toEqual({ kind: 'ready', email: 'rita@club.tt' })
  })

  it('formats the date an agent was connected for a reader', () => {
    const view = selectClaudeAccess(
      buildAgentAccess({
        state: 'connected',
        email: 'rita@club.tt',
        connected_on: '2026-05-12T09:30:00Z',
      }),
    )

    expect(view.status).toEqual({
      kind: 'connected',
      email: 'rita@club.tt',
      connectedOn: 'May 12, 2026',
    })
  })

  it('falls back to an em dash rather than hide that an agent is connected', () => {
    const view = selectClaudeAccess(
      buildAgentAccess({ state: 'connected', email: null, connected_on: null }),
    )

    expect(view.status).toEqual({
      kind: 'connected',
      email: '—',
      connectedOn: '—',
    })
  })

  it('empties only the ready row when the deployment has no connector', () => {
    // `ready` is the one state the setup panel IS, so without a connector it
    // has nothing left to show.
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'ready', connector: null }))
        .status,
    ).toEqual({ kind: 'unavailable' })
  })

  it('keeps every other state, and its action, when there is no connector', () => {
    // A missing connector must not outrank these. It did once, and it took the
    // Disconnect button off a connected page and the re-allow button off a
    // revoked one — a live agent with no off switch.
    for (const state of ['guest', 'gated', 'revoked'] as const) {
      expect(
        selectClaudeAccess(buildAgentAccess({ state, connector: null })).status,
      ).toEqual({ kind: state })
    }

    expect(
      selectClaudeAccess(
        buildAgentAccess({ state: 'connected', connector: null }),
      ).status.kind,
    ).toBe('connected')
  })

  it('refuses the ready row when there is no email to name in it', () => {
    // The server cannot produce this — a player with no email resolves to
    // `guest` — but "Use —" would be a dead end, so it fails closed instead.
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'ready', email: null }))
        .status,
    ).toEqual({ kind: 'unavailable' })
  })

  it('keeps the grant summary until an agent is actually connected', () => {
    for (const state of ['guest', 'gated', 'revoked', 'ready'] as const) {
      expect(
        selectClaudeAccess(buildAgentAccess({ state })).showsPermissionsSummary,
      ).toBe(true)
    }
    expect(
      selectClaudeAccess(buildAgentAccess({ state: 'connected' }))
        .showsPermissionsSummary,
    ).toBe(false)
  })

  it('carries the username and connector through for the page to render', () => {
    const view = selectClaudeAccess(
      buildAgentAccess({ username: 'rita.kovac' }),
    )

    expect(view.username).toBe('rita.kovac')
    expect(view.connector).toEqual({
      url: 'https://fortymm.com/api/mcp/',
      client_id: 'aBcD1234eFgH5678',
    })
  })
})

describe('claudeAccessLoadFailedView', () => {
  it('is the same fail-closed row, with nothing else claimed', () => {
    const view = claudeAccessLoadFailedView()

    expect(view.status).toEqual({ kind: 'unavailable' })
    expect(view.connector).toBeNull()
    // No username was loaded, so the summary's "everything appears under …"
    // would have an empty subject.
    expect(view.showsPermissionsSummary).toBe(false)
  })
})
