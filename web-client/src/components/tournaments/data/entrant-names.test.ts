import { WITHDRAWN_LABEL } from './draw'
import { nameByEntryId, nameOf } from './entrant-names'
import { buildEntrant, buildEvent } from './seed.factory'

describe('nameByEntryId', () => {
  it('keys each entrant’s username by its entry id', () => {
    const event = buildEvent({
      entrants: [
        buildEntrant({ id: 'entry-1', username: 'player.1' }),
        buildEntrant({ id: 'entry-2', username: 'player.2' }),
      ],
    })

    const names = nameByEntryId(event)

    expect(names.get('entry-1')).toBe('player.1')
    expect(names.get('entry-2')).toBe('player.2')
  })
})

describe('nameOf', () => {
  const names = new Map([['entry-1', 'player.1']])

  it('joins a known entry id to its username', () => {
    expect(nameOf('entry-1', names)).toBe('player.1')
  })

  it('falls back to the withdrawn label for an id the event no longer lists', () => {
    // A player who withdrew after being placed is no longer an entrant, so the map has no
    // name for them — the reader sees the word, never a raw id.
    expect(nameOf('entry-gone', names)).toBe(WITHDRAWN_LABEL)
  })
})
