import { describe, expect, it } from 'vitest'

import { scoringNewRoute, type MatchListRow } from '@/api/matches'
import type { components } from '@/api/schema'
import { matchListRow } from '@/test/factories'
import {
  API_TO_TONE,
  STATUS_TABS,
  STATUS_TONE,
  TAB_TO_API,
} from './match-list-status'
import {
  buildFilterTabs,
  formatCreatedAt,
  projectMatchListRow,
  shortId,
  sideLabel,
} from './match-list-row-view'

type MatchListRowSide = components['schemas']['MatchDetailsSide']

/** A side with the given usernames; defaults to side 1, lost. */
function side(
  usernames: string[],
  overrides: Partial<MatchListRowSide> = {},
): MatchListRowSide {
  return {
    side_number: 1,
    players: usernames.map((username, i) => ({
      user_id: `u-${username}-${i}`,
      username,
      is_current_user: false,
    })),
    games_won: 0,
    won: null,
    is_current_user_side: false,
    ...overrides,
  }
}

describe('sideLabel', () => {
  it('joins a side\'s usernames with " & "', () => {
    expect(sideLabel(side(['nguyen.t', 'silva.r']))).toBe('nguyen.t & silva.r')
  })

  it('returns "No opponent" for a null side', () => {
    expect(sideLabel(null)).toBe('No opponent')
  })

  it('returns "No opponent" for a player-less side', () => {
    expect(sideLabel(side([]))).toBe('No opponent')
  })
})

describe('shortId', () => {
  it('upper-cases the last 6 characters', () => {
    expect(shortId('match-abc123')).toBe('ABC123')
  })

  it('zero-pads ids shorter than 6 characters', () => {
    expect(shortId('a1')).toBe('0000A1')
  })
})

describe('formatCreatedAt', () => {
  it('shows zero-padded hh:mm for a same-day timestamp', () => {
    const created = new Date('2026-06-14T04:05:00')
    const now = new Date('2026-06-14T20:00:00')
    expect(formatCreatedAt(created.toISOString(), now)).toBe('04:05')
  })

  it('reads "yesterday" for a one-day-old timestamp', () => {
    const created = new Date('2026-06-13T10:00:00')
    const now = new Date('2026-06-14T12:00:00')
    expect(formatCreatedAt(created.toISOString(), now)).toBe('yesterday')
  })

  it('reads "Nd ago" for a timestamp under 30 days old', () => {
    const created = new Date('2026-06-09T10:00:00')
    const now = new Date('2026-06-14T12:00:00')
    expect(formatCreatedAt(created.toISOString(), now)).toBe('5d ago')
  })

  it('falls back to the locale date at 30 days or older', () => {
    const created = new Date('2026-05-01T10:00:00')
    const now = new Date('2026-06-14T12:00:00')
    expect(formatCreatedAt(created.toISOString(), now)).toBe(
      created.toLocaleDateString(),
    )
  })
})

describe('projectMatchListRow', () => {
  it('picks side_number 1 then 2, falling back to sides[0]/null', () => {
    const s1 = side(['alpha'], { side_number: 1, games_won: 3 })
    const s2 = side(['beta'], { side_number: 2, games_won: 1 })
    const row = matchListRow({ status: 'completed', sides: [s2, s1] })
    const view = projectMatchListRow(row)
    expect(view.side1.name).toBe('alpha')
    expect(view.side2.name).toBe('beta')
  })

  it('falls back to sides[0] for side1 and null for side2 on a solo row', () => {
    const solo = side(['only.player'], { side_number: 1 })
    const row = matchListRow({ status: 'pending', sides: [solo] })
    const view = projectMatchListRow(row)
    expect(view.side1.name).toBe('only.player')
    expect(view.side2.name).toBe('No opponent')
    expect(view.side2.isEmpty).toBe(true)
  })

  it('renders a games score only when in_progress/completed and side2 is present', () => {
    const s1 = side(['alpha'], { side_number: 1, games_won: 3 })
    const s2 = side(['beta'], { side_number: 2, games_won: 1 })
    const completed = matchListRow({ status: 'completed', sides: [s1, s2] })
    expect(projectMatchListRow(completed).score.games).toBe('3–1')

    const inProgress = matchListRow({ status: 'in_progress', sides: [s1, s2] })
    expect(projectMatchListRow(inProgress).score.games).toBe('3–1')
  })

  it('leaves the score pending (null) for a pending row', () => {
    const s1 = side(['alpha'], { side_number: 1, games_won: 0 })
    const s2 = side(['beta'], { side_number: 2, games_won: 0 })
    const row = matchListRow({ status: 'pending', sides: [s1, s2] })
    expect(projectMatchListRow(row).score.games).toBeNull()
  })

  it('leaves the score pending (null) when there is no second side', () => {
    const solo = side(['alpha'], { side_number: 1, games_won: 2 })
    const row = matchListRow({ status: 'completed', sides: [solo] })
    expect(projectMatchListRow(row).score.games).toBeNull()
  })

  it('resolves the status tone from STATUS_TONE[API_TO_TONE[status]]', () => {
    const row = matchListRow({ status: 'disputed', status_label: 'Disputed' })
    const view = projectMatchListRow(row)
    expect(view.status.toneClass).toBe(STATUS_TONE[API_TO_TONE.disputed])
    expect(view.status.toneClass).toBe('status-tone-final')
    expect(view.status.label).toBe('Disputed')
  })

  it('marks isLive only for in_progress', () => {
    expect(
      projectMatchListRow(matchListRow({ status: 'in_progress' })).isLive,
    ).toBe(true)
    expect(
      projectMatchListRow(matchListRow({ status: 'completed' })).isLive,
    ).toBe(false)
    expect(projectMatchListRow(matchListRow({ status: 'completed' })).status.isLive).toBe(
      false,
    )
  })

  // The #381 bug at the row level: a posted-but-unconfirmed result is an
  // in_progress row labelled "Awaiting confirmation". It must NOT read as Live
  // (no live-dot) and must take its own "called" tone, not the live tone.
  it('does not mark an awaiting-confirmation row as live and re-tones it', () => {
    const row = matchListRow({
      status: 'in_progress',
      status_label: 'Awaiting confirmation',
    })
    const view = projectMatchListRow(row)
    expect(view.isLive).toBe(false)
    expect(view.status.isLive).toBe(false)
    expect(view.status.toneClass).toBe('status-tone-called')
    expect(view.status.toneClass).not.toBe(STATUS_TONE.live)
    expect(view.status.label).toBe('Awaiting confirmation')
  })

  it('still marks a signature-free in_progress row as live', () => {
    const row = matchListRow({ status: 'in_progress', status_label: 'Live' })
    const view = projectMatchListRow(row)
    expect(view.isLive).toBe(true)
    expect(view.status.toneClass).toBe('status-tone-live')
  })

  it('builds the aria label as "Open match: {s1} vs {s2}"', () => {
    const s1 = side(['alpha'], { side_number: 1 })
    const s2 = side(['beta'], { side_number: 2 })
    const row = matchListRow({ sides: [s1, s2] })
    expect(projectMatchListRow(row).ariaLabel).toBe('Open match: alpha vs beta')
  })

  it('builds the short label as "M-" + shortId', () => {
    const row = matchListRow({ id: 'match-abc123' })
    expect(projectMatchListRow(row).shortLabel).toBe('M-ABC123')
  })

  it('marks the winning side and not the loser', () => {
    const s1 = side(['winner'], { side_number: 1, won: true })
    const s2 = side(['loser'], { side_number: 2, won: false })
    const row = matchListRow({ status: 'completed', sides: [s1, s2] })
    const view = projectMatchListRow(row)
    expect(view.side1.isWinner).toBe(true)
    expect(view.side2.isWinner).toBe(false)
  })

  it('omits the score route when current_game_number is null', () => {
    const row = matchListRow({ current_game_number: null })
    expect(projectMatchListRow(row).scoreRoute).toBeNull()
  })

  it('links the score route to the current game otherwise', () => {
    const row: MatchListRow = matchListRow({
      id: 'm-live',
      current_game_number: 3,
    })
    expect(projectMatchListRow(row).scoreRoute).toEqual(
      scoringNewRoute('m-live', 3),
    )
  })
})

describe('buildFilterTabs', () => {
  it('sums every status bucket plus the awaiting bucket for the "all" tab', () => {
    const tabs = buildFilterTabs(
      STATUS_TABS,
      { pending: 2, in_progress: 1, completed: 4 },
      TAB_TO_API,
      3,
    )
    const all = tabs.find((t) => t.value === 'all')
    expect(all?.count).toBe(10)
  })

  it('uses statusCounts[TAB_TO_API[value]] ?? 0 for each status-backed tab', () => {
    const tabs = buildFilterTabs(STATUS_TABS, { in_progress: 3 }, TAB_TO_API, 0)
    const live = tabs.find((t) => t.value === 'live')
    const scheduled = tabs.find((t) => t.value === 'scheduled')
    expect(live?.count).toBe(3)
    // Absent in the counts map → 0, not null.
    expect(scheduled?.count).toBe(0)
  })

  // The #381 fix at the count level: the Live count reads the (already
  // awaiting-subtracted) in_progress count, the Awaiting count reads its own
  // bucket. A posted-but-unconfirmed result is counted once, under Awaiting,
  // never under Live.
  it('reads the awaiting tab from awaitingCount, separate from live', () => {
    const tabs = buildFilterTabs(
      STATUS_TABS,
      { in_progress: 2 },
      TAB_TO_API,
      5,
    )
    expect(tabs.find((t) => t.value === 'live')?.count).toBe(2)
    expect(tabs.find((t) => t.value === 'awaiting')?.count).toBe(5)
  })

  it('returns a null count for every tab when statusCounts is undefined', () => {
    const tabs = buildFilterTabs(STATUS_TABS, undefined, TAB_TO_API, 4)
    expect(tabs.every((t) => t.count === null)).toBe(true)
  })

  it('treats a missing awaitingCount as 0', () => {
    const tabs = buildFilterTabs(STATUS_TABS, { in_progress: 1 }, TAB_TO_API, undefined)
    expect(tabs.find((t) => t.value === 'awaiting')?.count).toBe(0)
  })

  it('carries the label and live flag through from the tab descriptors', () => {
    const tabs = buildFilterTabs(STATUS_TABS, undefined, TAB_TO_API, 0)
    const live = tabs.find((t) => t.value === 'live')
    expect(live?.label).toBe('Live')
    expect(live?.isLive).toBe(true)
    const all = tabs.find((t) => t.value === 'all')
    expect(all?.isLive).toBe(false)
    const awaiting = tabs.find((t) => t.value === 'awaiting')
    expect(awaiting?.label).toBe('Awaiting')
    expect(awaiting?.isLive).toBe(false)
  })
})
