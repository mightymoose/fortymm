import { describe, expect, it } from 'vitest'
import {
  acknowledge,
  adopts,
  boardsOf,
  dropBoard,
  learnBoard,
  matchesWithPending,
  saveBoard,
  unsyncedGames,
} from './boards'
import type { Fragment } from './fragment'
import type { MatchResult } from '../signing/result'

const result = {} as MatchResult
const at = (issuedAt: number): Fragment => ({ kind: 'draft', issuedAt, result })
const empty: Fragment = { kind: 'empty' }

describe('the boards this tab keeps', () => {
  it('keeps only the newest unsent board', () => {
    saveBoard('m1', 'a')
    saveBoard('m1', 'b')

    expect(boardsOf('m1')).toEqual({ pending: 'b', synced: null })
    expect(matchesWithPending()).toBe('m1')
  })

  it('keeps a board saved while an older one was on its way', () => {
    saveBoard('m2', 'a')
    saveBoard('m2', 'b')
    acknowledge('m2', 'a')

    expect(boardsOf('m2')).toEqual({ pending: 'b', synced: 'a' })

    acknowledge('m2', 'b')

    expect(boardsOf('m2')).toEqual({ pending: null, synced: 'b' })
    expect(matchesWithPending()).toBe('')
  })

  it('drops a refused board only if nothing newer replaced it', () => {
    saveBoard('m3', 'a')
    saveBoard('m3', 'b')
    dropBoard('m3', 'a')

    expect(boardsOf('m3').pending).toBe('b')

    dropBoard('m3', 'b')
    learnBoard('m3', 'c')

    expect(boardsOf('m3')).toEqual({ pending: null, synced: 'c' })
  })
})

describe('unsyncedGames', () => {
  it('lists the games whose points differ, cleared ones too', () => {
    expect(
      unsyncedGames(
        [
          [11, 3],
          [5, 11],
        ],
        [
          [11, 3],
          [7, 11],
          [11, 9],
        ],
      ),
    ).toEqual(new Set([2, 3]))
    expect(unsyncedGames([[11, 3]], [[11, 3]])).toEqual(new Set())
  })
})

describe('adopts', () => {
  it('follows the server while the tab shows nothing or what it last synced', () => {
    expect(adopts({ text: '', fragment: empty }, { text: 'b', fragment: at(1) }, null)).toBe(true)
    expect(adopts({ text: 'a', fragment: at(9) }, { text: 'b', fragment: at(1) }, 'a')).toBe(true)
    expect(adopts({ text: 'a', fragment: at(9) }, { text: '', fragment: empty }, 'a')).toBe(true)
  })

  it('keeps a board from a link unless the pulled one is newer', () => {
    expect(adopts({ text: 'a', fragment: at(5) }, { text: 'b', fragment: at(5) }, null)).toBe(false)
    expect(adopts({ text: 'a', fragment: at(5) }, { text: 'b', fragment: at(6) }, null)).toBe(true)
    expect(adopts({ text: 'a', fragment: at(5) }, { text: '', fragment: empty }, null)).toBe(false)
  })

  it('changes nothing for the board already on screen', () => {
    expect(adopts({ text: 'a', fragment: at(5) }, { text: 'a', fragment: at(5) }, null)).toBe(false)
  })
})
