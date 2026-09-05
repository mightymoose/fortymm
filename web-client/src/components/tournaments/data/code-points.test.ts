import { exceedsCodePoints } from './code-points'

/** A stand-in string whose code-point iterator reports every pull, so a test
 * can tell an early exit from a full walk. A primitive carries no such probe,
 * which is why the helper takes this through a cast: it reads the same
 * `length` and walks the same `Symbol.iterator` a real string does. */
const counted = (value: string) => {
  let pulls = 0
  const probe = {
    length: value.length,
    [Symbol.iterator]: function* () {
      for (const char of value) {
        pulls++
        yield char
      }
    },
  }
  return { asString: probe as unknown as string, pulls: () => pulls }
}

describe('exceedsCodePoints', () => {
  it('accepts a string at the bound and refuses one past it', () => {
    expect(exceedsCodePoints('x'.repeat(254), 255)).toBe(false)
    expect(exceedsCodePoints('x'.repeat(255), 255)).toBe(false)
    expect(exceedsCodePoints('x'.repeat(256), 255)).toBe(true)
  })

  // The server counts code points, not UTF-16 code units: 255 emoji are 510
  // units but 255 code points, and the server takes them.
  it('counts a supplementary character as one code point, the way the server does', () => {
    const emoji = '🏆'.repeat(255)
    expect(emoji.length).toBe(510)

    expect(exceedsCodePoints(emoji, 255)).toBe(false)
    expect(exceedsCodePoints(`${emoji}🏆`, 255)).toBe(true)
  })

  // The finding (#1593 review): the `[...v].length` this replaced materialized
  // every code point before answering — unbounded work, repeated on every
  // keystroke against a huge pasted value. The verdict must arrive after at
  // most max + 1 pulls, whatever the value's length.
  it('stops counting once max + 1 code points have been seen', () => {
    const probe = counted('y'.repeat(100_000))

    expect(exceedsCodePoints(probe.asString, 1024)).toBe(true)
    expect(probe.pulls()).toBe(1025)
  })

  // The fast path: a value whose UTF-16 length already fits the bound cannot
  // exceed a code-point bound either, so the ordinary typing path never walks.
  it('answers a fitting value without walking it at all', () => {
    const probe = counted('z'.repeat(100))

    expect(exceedsCodePoints(probe.asString, 1024)).toBe(false)
    expect(probe.pulls()).toBe(0)
  })
})
