type Move = (index: number, count: number) => number

const previous: Move = (index, count) => (index - 1 + count) % count
const next: Move = (index, count) => (index + 1) % count
const first: Move = () => 0
const last: Move = (_, count) => count - 1

// Where each key moves the focus along a row of `count` items from the one
// at `index`, wrapping at the ends: the keys of the WAI-ARIA tabs and
// menubar patterns. A key not in here doesn't move it.
export const rowKeys: Record<string, Move> = {
  ArrowLeft: previous,
  ArrowRight: next,
  Home: first,
  End: last,
}

// The same moves down a column of items: the keys of the WAI-ARIA menu
// pattern.
export const columnKeys: Record<string, Move> = {
  ArrowUp: previous,
  ArrowDown: next,
  Home: first,
  End: last,
}
