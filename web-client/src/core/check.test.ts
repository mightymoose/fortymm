import { expect, test, vi } from 'vitest'
import { checkCore } from './check.ts'
import { loadCore } from './load.ts'

// The real core, built by core:wasm (src/test/setup.ts). The expected name is
// its golden vector for this player id and suffix length
// (core/vectors/vectors.json, "usernames").
test('checkCore says the core loaded, with the username the core gives player e2286f7c', async () => {
  expect(await checkCore()).toEqual({
    loaded: true,
    playerId: 'e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c25',
    username: 'tiptoeing-pinto-hng5',
  })
})

test('checkCore says the core did not load when loading it fails, without throwing', async () => {
  vi.mocked(loadCore).mockRejectedValue(new Error('no module'))
  expect(await checkCore()).toEqual({ loaded: false })
})
