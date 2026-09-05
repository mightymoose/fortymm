/**
 * How the server's Pydantic bounds count a string: Unicode code points. Zod's
 * own `.max` counts UTF-16 code units (`string.length`), under which a
 * supplementary character — most emoji, some CJK — is two. A string the server
 * accepts would be refused client-side by a unit-counting `.max`, and one the
 * server refuses would slip past a `.max` sized on the unit count. This is the
 * one counter both sides agree on (#1593).
 */

/** True when `value` holds more than `max` code points — the server's refusal,
 * decided without counting the rest of the string.
 *
 * The count walks the string's own code-point iterator and stops the moment
 * `max + 1` of them have been seen, so the work is bounded by the CONFIGURED
 * LIMIT rather than by the value: a form validating on every keystroke
 * (`mode: 'onChange'`) re-runs this against whatever a large paste left in the
 * box, and answering by materializing every code point first
 * (`[...value].length`) allocated the whole array each time — past a few
 * million characters, that alone could wedge the tab (#1593 review).
 *
 * The UTF-16 fast path comes first: a code point is one or two code units,
 * never zero, so a value whose `length` already fits the bound cannot exceed
 * it — and the ordinary typing path never leaves this path. */
export function exceedsCodePoints(value: string, max: number): boolean {
  if (value.length <= max) return false
  const codePoints = value[Symbol.iterator]()
  let seen = 0
  while (!codePoints.next().done) {
    if (++seen > max) return true
  }
  return false
}
