import type { MatchStatus } from '@/api/matches'

import {
  API_TO_TAB,
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

  it('leaves status undefined when the search has none', () => {
    expect(listParamsFromSearch({}).status).toBe(undefined)
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

describe('TAB_TO_API / API_TO_TAB', () => {
  it('are mutual inverses for the three primary tabs', () => {
    for (const tab of STATUS_KEYS) {
      expect(API_TO_TAB[TAB_TO_API[tab]]).toBe(tab)
    }
  })

  it('folds the terminal statuses to the final tab', () => {
    const terminal: MatchStatus[] = ['disputed', 'voided']
    for (const status of terminal) {
      expect(API_TO_TAB[status]).toBe('final')
    }
  })
})
