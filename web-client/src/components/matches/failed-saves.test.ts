import { renderHook, act } from '@/test/utilities'
import {
  clearFailedSave,
  dismissSaveFlash,
  failedSaveFor,
  recordFailedSave,
  resetFailedSaves,
  useFailedSaves,
} from './failed-saves'

describe('failed-saves store', () => {
  beforeEach(() => resetFailedSaves())
  afterEach(() => resetFailedSaves())

  it('keeps the entered points and arms the flash when a save fails', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )

    expect(failedSaveFor(result.current.entries, 'm-1', 2)).toEqual({
      side_1_points: 9,
      side_2_points: 11,
    })
    expect(result.current.flash).toMatchObject({ matchId: 'm-1', gameNumber: 2 })
  })

  it('scopes entries to the match and game', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )

    expect(failedSaveFor(result.current.entries, 'm-1', 3)).toBeNull()
    expect(failedSaveFor(result.current.entries, 'm-2', 2)).toBeNull()
  })

  it('a repeat failure for the same game re-arms the flash with a new id', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )
    const firstId = result.current.flash!.id
    act(() => dismissSaveFlash())
    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 8, side_2_points: 11 }),
    )

    expect(result.current.flash!.id).not.toBe(firstId)
    expect(failedSaveFor(result.current.entries, 'm-1', 2)).toEqual({
      side_1_points: 8,
      side_2_points: 11,
    })
  })

  it('clearing a game drops its entry and retires a flash pointed at it', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )
    act(() => clearFailedSave('m-1', 2))

    expect(failedSaveFor(result.current.entries, 'm-1', 2)).toBeNull()
    expect(result.current.flash).toBeNull()
  })

  it('clearing the same game number in a different match leaves the flash up', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )
    act(() => clearFailedSave('m-2', 2))

    expect(result.current.flash).toMatchObject({ matchId: 'm-1', gameNumber: 2 })
    expect(failedSaveFor(result.current.entries, 'm-1', 2)).toEqual({
      side_1_points: 9,
      side_2_points: 11,
    })
  })

  it('clearing one game leaves an unrelated flash up', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )
    act(() =>
      recordFailedSave('m-1', 4, { side_1_points: 5, side_2_points: 11 }),
    )
    act(() => clearFailedSave('m-1', 2))

    expect(result.current.flash).toMatchObject({ matchId: 'm-1', gameNumber: 4 })
    expect(failedSaveFor(result.current.entries, 'm-1', 4)).toEqual({
      side_1_points: 5,
      side_2_points: 11,
    })
  })

  it('dismissing the flash keeps the failed entry (the cell stays failed)', () => {
    const { result } = renderHook(() => useFailedSaves())

    act(() =>
      recordFailedSave('m-1', 2, { side_1_points: 9, side_2_points: 11 }),
    )
    act(() => dismissSaveFlash())

    expect(result.current.flash).toBeNull()
    expect(failedSaveFor(result.current.entries, 'm-1', 2)).toEqual({
      side_1_points: 9,
      side_2_points: 11,
    })
  })
})
