// In-memory seed data for the Tournament CRUD prototype: the populated
// "Bay Area Open 2026", a draft, and an archived event. There is no backend —
// the store (./store) loads these once and mutates them for the session.

import { buildTables } from './seed.factory'
import type { Tournament, TournamentTable } from './types'

export function seedTables(): TournamentTable[] {
  return buildTables(12)
}

export function seedTournaments(): Tournament[] {
  return [
    {
      id: 'bay-area-open-2026',
      name: 'Bay Area Open 2026',
      status: 'published',
      startDate: '2026-06-13',
      endDate: '2026-06-14',
      description: 'Two-day open. USATT-sanctioned, ratings-eligible.',
      address: {
        venue: 'Berkeley TT Club',
        street: '2727 Milvia St',
        city: 'Berkeley',
        region: 'CA',
        postal: '94703',
        country: 'USA',
      },
      tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'],
      events: [
        {
          id: 'ev-open-singles',
          name: 'Open Singles',
          format: 'singles',
          drawType: 'rr-then-ko',
          maxPlayers: 64,
          entryFee: 45,
          entered: 52,
          slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
          predicates: [],
          match: { rated: true, lengthGames: 5 },
          pools: [
            { id: 'p-os-1', name: 'Pool A', slot: { date: '2026-06-13', start: '09:00', end: '12:30' }, tableIds: ['t1', 't2', 't3', 't4'] },
            { id: 'p-os-2', name: 'Pool B', slot: { date: '2026-06-13', start: '13:30', end: '17:00' }, tableIds: ['t1', 't2', 't3', 't4', 't5', 't6'] },
          ],
        },
        {
          id: 'ev-womens',
          name: "Women's Singles",
          format: 'singles',
          drawType: 'single-elim',
          maxPlayers: 32,
          entryFee: 35,
          entered: 22,
          slot: { date: '2026-06-13', start: '10:00', end: '16:00' },
          predicates: [{ id: 'pr-1', field: 'gender', op: 'is', value: 'F' }],
          match: { rated: true, lengthGames: 5 },
          pools: [
            { id: 'p-w-1', name: 'Main draw', slot: { date: '2026-06-13', start: '10:00', end: '16:00' }, tableIds: ['t5', 't6', 't7', 't8'] },
          ],
        },
        {
          id: 'ev-u1500',
          name: 'U1500 Singles',
          format: 'singles',
          drawType: 'rr-then-ko',
          maxPlayers: 48,
          entryFee: 30,
          entered: 41,
          slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
          predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
          match: { rated: true, lengthGames: 3 },
          pools: [
            { id: 'p-u15-1', name: 'Pool A', slot: { date: '2026-06-14', start: '09:00', end: '12:00' }, tableIds: ['t1', 't2', 't3', 't4', 't5', 't6'] },
            { id: 'p-u15-2', name: 'Pool B', slot: { date: '2026-06-14', start: '13:00', end: '16:00' }, tableIds: ['t1', 't2', 't3', 't4'] },
          ],
        },
        {
          id: 'ev-u18',
          name: 'U18 Singles',
          format: 'singles',
          drawType: 'single-elim',
          maxPlayers: 24,
          entryFee: 20,
          entered: 18,
          slot: { date: '2026-06-13', start: '09:30', end: '13:00' },
          predicates: [{ id: 'pr-3', field: 'age', op: '<', value: 18 }],
          match: { rated: true, lengthGames: 3 },
          pools: [
            { id: 'p-u18-1', name: 'Group stage', slot: { date: '2026-06-13', start: '09:30', end: '13:00' }, tableIds: ['t9', 't10', 't11', 't12'] },
          ],
        },
        {
          id: 'ev-doubles',
          name: 'U2200 Doubles',
          format: 'doubles',
          drawType: 'single-elim',
          maxPlayers: 16,
          entryFee: 50,
          entered: 12,
          slot: { date: '2026-06-14', start: '10:00', end: '15:00' },
          predicates: [{ id: 'pr-4', field: 'rating', op: '<', value: 2200 }],
          match: { rated: false, lengthGames: 5 },
          pools: [
            { id: 'p-d-1', name: 'Doubles draw', slot: { date: '2026-06-14', start: '10:00', end: '15:00' }, tableIds: ['t7', 't8', 't9', 't10'] },
          ],
        },
      ],
    },
    {
      id: 'summer-slam-2026',
      name: 'Summer Slam 2026',
      status: 'draft',
      startDate: '2026-08-22',
      endDate: '2026-08-23',
      description: '',
      address: {
        venue: 'Palo Alto Community Center',
        street: '1313 Newell Rd',
        city: 'Palo Alto',
        region: 'CA',
        postal: '94303',
        country: 'USA',
      },
      tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
      events: [
        {
          id: 'ev-ss-open',
          name: 'Open Singles',
          format: 'singles',
          drawType: 'single-elim',
          maxPlayers: 32,
          entryFee: 40,
          entered: 0,
          slot: { date: '2026-08-22', start: '09:00', end: '17:00' },
          predicates: [],
          match: { rated: true, lengthGames: 5 },
          pools: [],
        },
      ],
    },
    {
      id: 'winter-classic-2025',
      name: 'Winter Classic 2025',
      status: 'archived',
      startDate: '2025-12-13',
      endDate: '2025-12-14',
      description: 'Concluded December 2025.',
      address: {
        venue: 'San Jose Sports Hall',
        street: '1500 Senter Rd',
        city: 'San Jose',
        region: 'CA',
        postal: '95112',
        country: 'USA',
      },
      tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
      events: [],
    },
  ]
}
