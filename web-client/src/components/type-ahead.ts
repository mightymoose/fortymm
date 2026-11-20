// What a person types between pressing Start match and game 1's scoring
// page opening (black-box #17): the match is being kept, so for a moment
// there is no score field, and keys typed then would be lost. From Start's
// press (NewMatchScreen, `keepKeys`) the digits and the keys that move from
// your field to theirs (Enter, Tab, ArrowRight) are kept, instead of
// reaching the new match page. The scoring page takes them when it opens
// (ScoringScreen, `takeKeys`) and types them into its fields. A Start the
// device refused drops them (`dropKeys`), and so does a page that doesn't
// open in time (`keptFor`), so keys are never kept from a page for long.
//
// An Enter before any digit isn't kept: on a focused Start it is Start
// pressed again (which does nothing), not a move to the opponent's field.
//
// Shared by NewMatchScreen and ScoringScreen, which have no common
// ancestor: so it is directly in components/.

// How long keys are kept if no scoring page takes them.
const keptFor = 10_000

const kept = /^[0-9]$|^(Enter|Tab|ArrowRight)$/

let keys: string[] | null = null
let stop = () => {}

export function keepKeys() {
  dropKeys()
  const typed: string[] = []
  keys = typed
  const keyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !kept.test(event.key)) return
    event.preventDefault()
    if (event.key === 'Enter' && !typed.some((key) => /^[0-9]$/.test(key))) return
    typed.push(event.key)
  }
  window.addEventListener('keydown', keyDown, true)
  const timer = setTimeout(dropKeys, keptFor)
  stop = () => {
    window.removeEventListener('keydown', keyDown, true)
    clearTimeout(timer)
  }
}

// Whether keys were typed since Start that a page hasn't taken.
export function hasKeys(): boolean {
  return keys !== null && keys.length > 0
}

// The keys kept since Start, in order; none when nothing is being kept.
// Keeping stops.
export function takeKeys(): string[] {
  const taken = keys ?? []
  dropKeys()
  return taken
}

export function dropKeys() {
  stop()
  stop = () => {}
  keys = null
}
