import { expect, test } from 'vitest'
import { newMatchSchema } from './NewMatchScreen.schema.ts'

test('the schema gives the match’s format, unrated', () => {
  expect(newMatchSchema.parse({ bestOf: 3 })).toEqual({
    format: { bestOf: 3 },
    rated: false,
  })
})

test.each([0, 2, 4, 9])(
  'the schema refuses best of %i: a match is best of 1, 3, 5 or 7',
  (bestOf) => {
    expect(newMatchSchema.safeParse({ bestOf }).success).toBe(false)
  },
)
