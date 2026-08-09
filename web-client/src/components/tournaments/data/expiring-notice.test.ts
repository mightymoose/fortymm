import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { noticeFingerprint, useExpiringNotice } from './expiring-notice'
import type { Notice } from './notice'

// A real one: the go-live 409, whose sentence names the events the director must fix
// (ADR-0786). It is the refusal the expiry rule exists for — the one a director reads
// *while* going to fix it, and the one that must vanish the moment they have.
const NO_DRAW_YET: Notice = {
  title: "Couldn't start the tournament",
  description:
    'This tournament cannot start yet: “Open Singles” has no draw yet.',
}

const STALE_DRAW: Notice = {
  title: "Couldn't start the tournament",
  description:
    'This tournament cannot start yet: “Over 40s” has a draw that no longer matches its entrants.',
}

/** The hook under a fingerprint the test can move, mounted under `StrictMode` because the
 * stamp is kept in a ref written from an effect — a mount → cleanup → remount must leave
 * it correct (`web-client/CLAUDE.md`). */
function renderExpiringNotice(fingerprint: NoticeFingerprintProps) {
  return renderHook(
    ({ fingerprint }: NoticeFingerprintProps) => useExpiringNotice(fingerprint),
    { wrapper: StrictMode, initialProps: fingerprint },
  )
}

interface NoticeFingerprintProps {
  fingerprint: string
}

describe('useExpiringNotice', () => {
  it('shows a refusal produced against the state on screen', () => {
    const { result } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })

    act(() => result.current[1](NO_DRAW_YET))

    expect(result.current[0]).toEqual(NO_DRAW_YET)
  })

  // The case most likely to regress: an over-eager rule that withdrew on any re-render, or
  // on any refetch, would take the director's work list away mid-fix.
  it('keeps showing it while the state it turns on is unchanged', () => {
    const { result, rerender } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    act(() => result.current[1](NO_DRAW_YET))

    // A fresh render, and fresh server data that says the same thing about the fields this
    // refusal turns on — a distinct string, an equal fingerprint.
    rerender({ fingerprint: noticeFingerprint('published', 2) })

    expect(result.current[0]).toEqual(NO_DRAW_YET)
  })

  it('withdraws it when the state it turns on changes', () => {
    const { result, rerender } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    act(() => result.current[1](NO_DRAW_YET))

    // The director cut the missing draw: the state the refusal described is gone, so the
    // refusal is too.
    rerender({ fingerprint: noticeFingerprint('published', 3) })

    expect(result.current[0]).toBeNull()
  })

  it('stays withdrawn when the fingerprint comes back around', () => {
    const { result, rerender } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    act(() => result.current[1](NO_DRAW_YET))

    // An entrant joins, then leaves again. The refusal stopped being true; it does not
    // un-stop, and a banner nobody re-asked for must not come back.
    rerender({ fingerprint: noticeFingerprint('published', 3) })
    rerender({ fingerprint: noticeFingerprint('published', 2) })

    expect(result.current[0]).toBeNull()
  })

  it('stamps the notice with the state at the moment it is stored, not the render that built the setter', () => {
    const { result, rerender } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    // The setter a click handler closed over, several renders ago.
    const show = result.current[1]

    // The mutation reconciled the tournament on settle (`./api` — on the failure path
    // too), so fresh data lands and the component re-renders BEFORE `mutateAsync` rejects.
    rerender({ fingerprint: noticeFingerprint('published', 3) })
    act(() => show(STALE_DRAW))

    // The refusal is about the state the server just answered against — it is not born
    // expired.
    expect(result.current[0]).toEqual(STALE_DRAW)
  })

  it('clears on null, so a new attempt does not report the click before last', () => {
    const { result } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    act(() => result.current[1](NO_DRAW_YET))

    act(() => result.current[1](null))

    expect(result.current[0]).toBeNull()
  })

  it('shows a fresh refusal produced against the new state', () => {
    const { result, rerender } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })
    act(() => result.current[1](NO_DRAW_YET))
    rerender({ fingerprint: noticeFingerprint('published', 3) })

    // Expiry withdraws a notice; it must not wedge the surface against reporting the next
    // refusal.
    act(() => result.current[1](STALE_DRAW))

    expect(result.current[0]).toEqual(STALE_DRAW)
  })

  it('shows nothing until something is refused', () => {
    const { result } = renderExpiringNotice({
      fingerprint: noticeFingerprint('published', 2),
    })

    expect(result.current[0]).toBeNull()
  })
})

describe('noticeFingerprint', () => {
  it('is equal for equal state', () => {
    expect(noticeFingerprint('round_robin', 5)).toBe(
      noticeFingerprint('round_robin', 5),
    )
  })

  it('differs when any part differs', () => {
    expect(noticeFingerprint('round_robin', 5)).not.toBe(
      noticeFingerprint('round_robin', 6),
    )
    expect(noticeFingerprint('round_robin', 5)).not.toBe(
      noticeFingerprint('single_elimination', 5),
    )
  })

  it('keeps the boundary between parts, so two states cannot blur into one', () => {
    // Concatenation would make these the same string, and a draw type of `a` with `b`
    // entrants indistinguishable from one of `ab`.
    expect(noticeFingerprint('a', 'b')).not.toBe(noticeFingerprint('ab'))
    expect(noticeFingerprint(1, 23)).not.toBe(noticeFingerprint(12, 3))
  })
})
