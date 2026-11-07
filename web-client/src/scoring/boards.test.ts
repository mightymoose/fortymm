import { describe, expect, it } from 'vitest'
import { acknowledge, boardsOf, dropBoard, matchesWithPending, saveBoard, unsyncedGames } from './boards'

describe('the boards this tab keeps', () => {
  it('keeps only the newest unsent board', () => {
    saveBoard('m1', 'a')
    saveBoard('m1', 'b')

    expect(boardsOf('m1')).toEqual({ pending: 'b', synced: null, refused: null })
    expect(matchesWithPending()).toBe('m1')
  })

  it('keeps a board saved while an older one was on its way', () => {
    saveBoard('m2', 'a')
    saveBoard('m2', 'b')
    acknowledge('m2', 'a')

    expect(boardsOf('m2')).toEqual({ pending: 'b', synced: 'a', refused: null })

    acknowledge('m2', 'b')

    expect(boardsOf('m2')).toEqual({ pending: null, synced: 'b', refused: null })
    expect(matchesWithPending()).toBe('')
  })

  it('drops a refused board only if nothing newer replaced it', () => {
    saveBoard('m3', 'a')
    saveBoard('m3', 'b')
    dropBoard('m3', 'a', 'other')

    expect(boardsOf('m3').pending).toBe('b')

    dropBoard('m3', 'b', 'final')

    expect(boardsOf('m3')).toEqual({ pending: null, synced: null, refused: 'final' })
  })

  it('keeps why a board was refused until a later one lands', () => {
    saveBoard('m4', 'a')
    dropBoard('m4', 'a', 'other')
    saveBoard('m4', 'b')

    expect(boardsOf('m4').refused).toBe('other')

    acknowledge('m4', 'b')

    expect(boardsOf('m4').refused).toBeNull()
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
