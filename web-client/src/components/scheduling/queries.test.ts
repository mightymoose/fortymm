import { describe, expect, it } from 'vitest'

import { buildAdminScheduleSolveRead } from './solve-ledger-page.factory'
import {
  SOLVE_LEDGER_PAGE_SIZE,
  adminScheduleSolvesQueryKey,
  parseAdminSolveLedgerPage,
  solveLedgerSearchSchema,
} from './queries'

const page = (items: unknown[] = [buildAdminScheduleSolveRead()]) => ({
  items,
  page: 1,
  page_size: SOLVE_LEDGER_PAGE_SIZE,
  total: items.length,
})

describe('parseAdminSolveLedgerPage', () => {
  it('parses a wire page into the domain spelling — snake_case in, camelCase out', () => {
    const parsed = parseAdminSolveLedgerPage(
      page([
        buildAdminScheduleSolveRead({
          input_fingerprint: 'abc123',
          rerun_requested: true,
          tournament_id: 't-9',
          tournament_name: 'Club Championship',
          wall_time_ms: 850,
        }),
      ]),
    )
    expect(parsed.pageSize).toBe(SOLVE_LEDGER_PAGE_SIZE)
    expect(parsed.total).toBe(1)
    expect(parsed.items[0]).toMatchObject({
      inputFingerprint: 'abc123',
      rerunRequested: true,
      tournamentId: 't-9',
      tournamentName: 'Club Championship',
      wallTimeMs: 850,
      trigger: 'manual',
      status: 'succeeded',
      verdict: 'optimal',
    })
  })

  it('refuses an enum member this client does not know — at the boundary, not in a switch', () => {
    expect(() =>
      parseAdminSolveLedgerPage(
        page([buildAdminScheduleSolveRead({ trigger: 'cosmic_ray' as never })]),
      ),
    ).toThrow()
    expect(() =>
      parseAdminSolveLedgerPage(
        page([buildAdminScheduleSolveRead({ status: 'exploded' as never })]),
      ),
    ).toThrow()
  })

  it('refuses an ABSENT nullable — a payload that omits a stage-marker is not a payload that means "stage not reached"', () => {
    const missingFingerprint: Record<string, unknown> = {
      ...buildAdminScheduleSolveRead(),
    }
    delete missingFingerprint.input_fingerprint
    expect(() => parseAdminSolveLedgerPage(page([missingFingerprint]))).toThrow()
  })

  it('passes null stage-markers straight through — each null is a fact', () => {
    const parsed = parseAdminSolveLedgerPage(
      page([
        buildAdminScheduleSolveRead({
          status: 'queued',
          verdict: null,
          started_at: null,
          finished_at: null,
          wall_time_ms: null,
          fixtures_placed: null,
          fixtures_pinned: null,
          input_fingerprint: null,
        }),
      ]),
    )
    expect(parsed.items[0].inputFingerprint).toBeNull()
    expect(parsed.items[0].wallTimeMs).toBeNull()
  })
})

describe('adminScheduleSolvesQueryKey', () => {
  it('keys on page AND filter, normalizing an absent filter to null', () => {
    expect(adminScheduleSolvesQueryKey({ page: 2 })).toEqual([
      'admin',
      'schedule-solves',
      { page: 2, tournamentId: null },
    ])
    expect(adminScheduleSolvesQueryKey({ page: 1, tournamentId: 't-1' })).toEqual([
      'admin',
      'schedule-solves',
      { page: 1, tournamentId: 't-1' },
    ])
  })
})

describe('solveLedgerSearchSchema', () => {
  it('parses good params and coerces the page number', () => {
    expect(solveLedgerSearchSchema.parse({ page: '3', tournament: 't-1' })).toEqual({
      page: 3,
      tournament: 't-1',
    })
  })

  it('drops junk to the defaults instead of throwing — page 1 is spelled by absence', () => {
    expect(solveLedgerSearchSchema.parse({ page: 'banana', tournament: '' })).toEqual(
      {},
    )
    expect(solveLedgerSearchSchema.parse({ page: '1' })).toEqual({})
    expect(solveLedgerSearchSchema.parse({})).toEqual({})
  })
})
