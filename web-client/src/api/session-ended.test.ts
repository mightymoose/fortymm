import { describe, expect, it } from 'vitest'
import { handleSessionEnded, type SessionEndedActions } from './session-ended'

/** Records the ORDER the steps ran in, not merely that they ran. */
function recorder() {
  const calls: string[] = []
  const actions: SessionEndedActions = {
    closeRealtime: () => void calls.push('closeRealtime'),
    clearAppEntered: () => void calls.push('clearAppEntered'),
    clearQueryCache: () => void calls.push('clearQueryCache'),
    notify: (message) => void calls.push(`notify:${message}`),
    navigateToLogin: (email) => void calls.push(`navigate:${email ?? '-'}`),
  }
  return { calls, actions }
}

describe('handleSessionEnded', () => {
  /**
   * ⚠️ The assertion that matters, and the reason this is a list rather than
   * five `toHaveBeenCalled()`s: **the stream is closed BEFORE the cache is
   * cleared.** With the two the other way round every one of those five spies
   * would still be satisfied, and the bug would ship — `queryClient.clear()` is
   * synchronous while the redirect after it is not, so a stream still reading
   * during that window can answer a hint by refetching the departed user's
   * dashboard straight back into the cache that was just emptied.
   */
  it('closes the realtime stream before clearing the query cache', () => {
    const { calls, actions } = recorder()

    handleSessionEnded(actions, { message: 'Your session has ended.' })

    expect(calls.indexOf('closeRealtime')).toBeLessThan(
      calls.indexOf('clearQueryCache'),
    )
  })

  it('runs the whole sequence, in order, and only then leaves', () => {
    const { calls, actions } = recorder()

    handleSessionEnded(actions, { message: 'Signed out elsewhere.' })

    expect(calls).toEqual([
      'closeRealtime',
      'clearAppEntered',
      'clearQueryCache',
      'notify:Signed out elsewhere.',
      'navigate:-',
    ])
  })

  it('carries the owning account’s email to the login screen when there is one', () => {
    const { calls, actions } = recorder()

    handleSessionEnded(actions, {
      message: 'This device was merged into another account.',
      email: 'owner@example.com',
    })

    expect(calls.at(-1)).toBe('navigate:owner@example.com')
  })
})
