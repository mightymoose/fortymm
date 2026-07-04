import type { MatchStatus } from '@/api/matches'

import {
  API_TO_TONE,
  PAGE_SIZE,
  STATUS_KEYS,
  TAB_TO_API,
  listParamsFromSearch,
  matchesSearchSchema,
} from './match-list-status'

describe('matchesSearchSchema', () => {
  it('drops a status outside the enum back to undefined', () => {
    expect(matchesSearchSchema.parse({ status: 'garbage' }).status).toBe(
      undefined,
    )
  })

  it('keeps a status that is a member of the enum', () => {
    for (const key of STATUS_KEYS) {
      expect(matchesSearchSchema.parse({ status: key }).status).toBe(key)
    }
  })

  it('keeps the attention status', () => {
    expect(matchesSearchSchema.parse({ status: 'attention' }).status).toBe(
      'attention',
    )
  })

  it('drops a non-numeric page back to undefined', () => {
    expect(matchesSearchSchema.parse({ page: 'NaN' }).page).toBe(undefined)
  })

  it('drops a page below 2 back to undefined', () => {
    expect(matchesSearchSchema.parse({ page: 1 }).page).toBe(undefined)
  })

  it('keeps a page of 2 or more', () => {
    expect(matchesSearchSchema.parse({ page: 3 }).page).toBe(3)
  })

  it('collapses a blank, whitespace-only query to undefined', () => {
    expect(matchesSearchSchema.parse({ q: '   ' }).q).toBe(undefined)
  })

  it('trims a non-blank query', () => {
    expect(matchesSearchSchema.parse({ q: '  nguyen  ' }).q).toBe('nguyen')
  })
})

describe('listParamsFromSearch', () => {
  it('maps the tab status through TAB_TO_API', () => {
    expect(listParamsFromSearch({ status: 'live' }).status).toBe('in_progress')
    expect(listParamsFromSearch({ status: 'scheduled' }).status).toBe('pending')
    expect(listParamsFromSearch({ status: 'final' }).status).toBe('completed')
  })

  // The bug in #381: the Live tab and the Awaiting tab must hit *distinct*
  // server buckets — otherwise a posted-but-unconfirmed result rides under
  // Live. `awaiting` maps to the dedicated `awaiting_acceptance` filter.
  it('maps the awaiting tab to the awaiting_acceptance filter, distinct from live', () => {
    expect(listParamsFromSearch({ status: 'awaiting' }).status).toBe(
      'awaiting_acceptance',
    )
    expect(listParamsFromSearch({ status: 'awaiting' }).status).not.toBe(
      listParamsFromSearch({ status: 'live' }).status,
    )
  })

  it('leaves status undefined when the search has none', () => {
    expect(listParamsFromSearch({}).status).toBe(undefined)
  })

  it('maps the attention tab to the attention flag with no status', () => {
    const params = listParamsFromSearch({ status: 'attention' })
    expect(params.attention).toBe(true)
    expect(params.status).toBe(undefined)
  })

  it('leaves the attention flag unset for non-attention tabs', () => {
    expect(listParamsFromSearch({ status: 'live' }).attention).toBe(undefined)
    expect(listParamsFromSearch({}).attention).toBe(undefined)
  })

  it('passes a non-empty query through and drops an empty one', () => {
    expect(listParamsFromSearch({ q: 'silva' }).q).toBe('silva')
    expect(listParamsFromSearch({ q: '' }).q).toBe(undefined)
  })

  it('defaults the page to 1 when absent', () => {
    expect(listParamsFromSearch({}).page).toBe(1)
  })

  it('keeps an explicit page', () => {
    expect(listParamsFromSearch({ page: 4 }).page).toBe(4)
  })

  it('sets page_size to PAGE_SIZE', () => {
    expect(listParamsFromSearch({}).page_size).toBe(PAGE_SIZE)
  })
})

describe('TAB_TO_API', () => {
  it('maps the status-backed tabs to their DB status round-trip', () => {
    // `awaiting` is the one tab with no DB status of its own (it's an
    // in_progress row with a posted result), so it's excluded from the
    // status↔tone round-trip.
    const statusBacked = STATUS_KEYS.filter((k) => k !== 'awaiting')
    for (const tab of statusBacked) {
      expect(API_TO_TONE[TAB_TO_API[tab] as MatchStatus]).toBe(tab)
    }
  })

  it('maps live and awaiting to distinct filter buckets', () => {
    expect(TAB_TO_API.live).toBe('in_progress')
    expect(TAB_TO_API.awaiting).toBe('awaiting_acceptance')
    expect(TAB_TO_API.live).not.toBe(TAB_TO_API.awaiting)
  })
})

describe('API_TO_TONE', () => {
  it('folds the terminal statuses to the final tone', () => {
    const terminal: MatchStatus[] = ['disputed', 'voided']
    for (const status of terminal) {
      expect(API_TO_TONE[status]).toBe('final')
    }
  })
})
