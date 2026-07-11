import { describe, expect, it } from 'vitest'
import { sparklineGeometry } from './sparkline'

describe('sparklineGeometry', () => {
  it('spaces the points evenly across the padded width', () => {
    const { points } = sparklineGeometry([1480, 1465, 1490, 1510], 302, 48)

    // 2px inset each side leaves 298 of usable width, split into 3 equal steps.
    expect(points.map((p) => p[0])).toEqual([
      2, 101.33333333333333, 200.66666666666666, 300,
    ])
  })

  it('scales the series min to the bottom and the max to the top', () => {
    // The dashboard rating card's default 280×48 canvas: the min (0) sits on
    // the bottom inset (48 - 2) and the max (10) on the top one.
    const { points, path, last } = sparklineGeometry([0, 10], 280, 48)

    expect(points).toEqual([
      [2, 46],
      [278, 2],
    ])
    expect(path).toBe('M2.0 46.0 L278.0 2.0')
    expect(last).toEqual([278, 2])
  })

  it('places an intermediate value proportionally between them', () => {
    // Midpoint of the series → midpoint of the padded height (2 → 34, so 18).
    const { points } = sparklineGeometry([1400, 1500, 1600], 110, 36)

    expect(points.map((p) => p[1])).toEqual([34, 18, 2])
  })

  it('pins a flat series to the baseline instead of dividing by a zero range', () => {
    // Every value equal → `max - min` is 0; the `|| 1` guard keeps the whole
    // series on the bottom inset rather than yielding NaN coordinates.
    const { points, path, last } = sparklineGeometry([1500, 1500, 1500], 110, 36)

    expect(points.map((p) => p[1])).toEqual([34, 34, 34])
    expect(path).toBe('M2.0 34.0 L55.0 34.0 L108.0 34.0')
    expect(last).toEqual([108, 34])
  })

  it('rounds each path coordinate to one decimal place', () => {
    // x steps by 5/3, so the second point lands on 3.666… — rounded up to 3.7
    // in the path string, not truncated to 3.6.
    const { path } = sparklineGeometry([0, 1, 2, 3], 9, 10)

    expect(path).toBe('M2.0 8.0 L3.7 6.0 L5.3 4.0 L7.0 2.0')
  })

  it('leaves `points` and `last` unrounded — only the path string rounds', () => {
    // The callers hang unrounded geometry off these: the match-details svg
    // `<circle>` and the rating card's percentage-positioned overlay dot.
    const { points, last } = sparklineGeometry([0, 1, 2, 3], 9, 10)

    expect(points[1][0]).toBeCloseTo(3.6666666666666665, 12)
    expect(last).toEqual([7, 2])
  })
})
