// A username's initials, for the avatar that stands for this device's user
// in the phone top bar (src/components/UserMarkLink.tsx): the first letter
// of each of the first two words, the words split on "-", upper-cased.
// agile-meerkat-4b8z gives AM; a one-word name gives its first letter; an
// empty name gives "".
export function initials(username: string): string {
  return username
    .split('-')
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => [...word][0])
    .join('')
    .toUpperCase()
}
