type Move = (index: number, count: number) => number

// Where each key moves the focus along a row of `count` items from the one
// at `index`, wrapping at the ends: the keys of the WAI-ARIA tabs and
// menubar patterns. A key not in here doesn't move it.
export const rowKeys: Record<string, Move> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
}
