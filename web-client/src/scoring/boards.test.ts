import { describe, expect, it } from 'vitest'
import { acknowledge, boardsOf, dropBoard, matchesWithPending, saveBoard, unsyncedGames } from './boards'

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

    expect(boardsOf('m3')).toEqual({ pending: null, synced: null })
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
