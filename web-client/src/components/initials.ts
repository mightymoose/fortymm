// The initials of a display name's first two words, e.g. `EE` for
// `excited egret 387`.
export function initials(displayName: string): string {
  return displayName
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}
