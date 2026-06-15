import { describe, expect, it } from 'vitest'

import {
  REGISTERED_PLAYER_LABEL,
  UNNAMED_PLAYER,
  displayPlayerName,
  playerAccessibleName,
  playerRoleLabel,
} from './player-identity'

describe('displayPlayerName', () => {
  it('returns the username unchanged when it has content', () => {
    expect(displayPlayerName('ada.lovelace')).toBe('ada.lovelace')
  })

  it('falls back for an empty username (#101)', () => {
    expect(displayPlayerName('')).toBe(UNNAMED_PLAYER)
  })

  it('falls back for a whitespace-only username (#101)', () => {
    expect(displayPlayerName('   ')).toBe(UNNAMED_PLAYER)
  })

  it('keeps an emoji-only username as readable text (#101)', () => {
    expect(displayPlayerName('🦘🔥💀')).toBe('🦘🔥💀')
  })
})

describe('playerRoleLabel', () => {
  it('shows the rounded rating when one is known', () => {
    expect(playerRoleLabel({ rating: 1432.6 })).toBe('RATING 1433')
  })

  it('falls back to the registered-player label without a rating', () => {
    expect(playerRoleLabel({ rating: null })).toBe(REGISTERED_PLAYER_LABEL)
  })
})

describe('playerAccessibleName', () => {
  it('combines the name and role without the decorative avatar (#99)', () => {
    expect(
      playerAccessibleName({ username: 'grace.hopper', rating: 1500 }),
    ).toBe('grace.hopper, RATING 1500')
  })

  it('uses the readable fallback name for a blank username (#101)', () => {
    expect(playerAccessibleName({ username: '', rating: null })).toBe(
      `${UNNAMED_PLAYER}, ${REGISTERED_PLAYER_LABEL}`,
    )
  })
})
