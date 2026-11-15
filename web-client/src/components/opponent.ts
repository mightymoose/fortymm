// How a screen names a match's opponent. `null` is a match recorded with no
// opponent's name: it reads "Anonymous", and its avatar shows "?" rather than
// an "A" that would look like a name's initial. The stores keep the `null`;
// only screens ask these.
export function opponentLabel(name: string | null): string {
  return name ?? 'Anonymous'
}

// The initials for the opponent's avatar: the first letter of each of the
// first two words ("Bea Okafor" gives BO), or "?" with no name.
export function opponentInitials(name: string | null): string {
  if (name === null) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('')
}
