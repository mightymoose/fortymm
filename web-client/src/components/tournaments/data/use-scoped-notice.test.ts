import { act, renderHook } from '@testing-library/react'
import { createElement, StrictMode, type ReactNode } from 'react'

import { useScopedNotice } from './use-scoped-notice'

/** The hook under test, driven by a scope the test moves — `rerender({ scope })` is
 * "the state underneath this notice changed", which is the whole thing being checked. */
const renderScoped = (scope: string) =>
  renderHook(({ scope }: { scope: string }) => useScopedNotice<string>(scope), {
    initialProps: { scope },
  })

/**
 * The same hook under **`<StrictMode>`**, which is how the app actually runs
 * (`src/main.tsx`) and how `npm run dev` and the composed e2e stack both run it.
 *
 * This matters here specifically: the reset is a **render-phase `setState`**, and
 * StrictMode double-invokes render. A plain `render` would never exercise that, which is
 * the repo's standing lesson about effect-lifecycle behaviour going green in vitest and
 * red only in e2e (`web-client/CLAUDE.md`, "StrictMode latches a cleanup-only mounted
 * ref"). The double-invoked pass must reach the same answer as the single one — that is
 * what makes the reset safe rather than merely working.
 */
const renderScopedStrict = (scope: string) =>
  renderHook(({ scope }: { scope: string }) => useScopedNotice<string>(scope), {
    initialProps: { scope },
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children),
  })

describe('useScopedNotice', () => {
  it('holds a notice while the state it describes is unchanged', () => {
    const { result, rerender } = renderScoped('no-events')

    act(() => result.current[1]('This tournament has no events'))
    expect(result.current[0]).toBe('This tournament has no events')

    // The same scope again — a poll that changed nothing. The director is mid-way
    // through reading a work list; it must still be there.
    rerender({ scope: 'no-events' })
    expect(result.current[0]).toBe('This tournament has no events')
  })

  it('drops the notice once the state it describes has changed', () => {
    const { result, rerender } = renderScoped('no-events')

    act(() => result.current[1]('This tournament has no events'))
    rerender({ scope: 'one-event' })

    expect(result.current[0]).toBeNull()
  })

  it('clears on demand, for the next attempt', () => {
    const { result } = renderScoped('no-events')

    act(() => result.current[1]('This tournament has no events'))
    act(() => result.current[1](null))

    expect(result.current[0]).toBeNull()
  })

  /**
   * The one a purely-derived notice fails.
   *
   * `shown = held.scope === scope ? held.notice : null` alone passes every test above:
   * it hides the notice when the scope moves. But it only *hides* it, so the moment the
   * scope comes back — a player enters an event and then withdraws, and the entrant count
   * returns to what it was — the old refusal reappears as though it had just been made.
   * Dropping the held value outright is what makes the clear permanent.
   */
  it('does not resurrect a dropped notice when the scope returns to its earlier value', () => {
    const { result, rerender } = renderScoped('0-entrants')

    act(() => result.current[1]('0 entrants across 2 pools'))
    rerender({ scope: '1-entrant' })
    expect(result.current[0]).toBeNull()

    rerender({ scope: '0-entrants' })
    expect(result.current[0]).toBeNull()
  })

  // The three claims again, under the double-invoked render the app really uses.
  describe('under StrictMode', () => {
    it('holds a notice while the state it describes is unchanged', () => {
      const { result, rerender } = renderScopedStrict('no-events')

      act(() => result.current[1]('This tournament has no events'))
      rerender({ scope: 'no-events' })

      expect(result.current[0]).toBe('This tournament has no events')
    })

    it('drops the notice once the state it describes has changed', () => {
      const { result, rerender } = renderScopedStrict('no-events')

      act(() => result.current[1]('This tournament has no events'))
      rerender({ scope: 'one-event' })

      expect(result.current[0]).toBeNull()
    })

    it('does not resurrect a dropped notice when the scope returns', () => {
      const { result, rerender } = renderScopedStrict('0-entrants')

      act(() => result.current[1]('0 entrants across 2 pools'))
      rerender({ scope: '1-entrant' })
      rerender({ scope: '0-entrants' })

      expect(result.current[0]).toBeNull()
    })
  })

  /** A notice set *after* the scope moved belongs to the new scope, not the old one —
   * the stamp is taken when the setter runs, so a fresh refusal shows immediately. */
  it('stamps a new notice with the scope current when it is set', () => {
    const { result, rerender } = renderScoped('0-entrants')

    act(() => result.current[1]('0 entrants across 2 pools'))
    rerender({ scope: '5-entrants' })
    act(() => result.current[1]('5 entrants across 3 pools would leave a pool short'))

    expect(result.current[0]).toBe(
      '5 entrants across 3 pools would leave a pool short',
    )
  })
})
