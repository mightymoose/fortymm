import { expect, test } from 'vitest'
import { newMatchSchema } from './NewMatchScreen.schema.ts'

test('the schema trims the opponent’s name and gives the match’s format', () => {
  expect(
    newMatchSchema.parse({ opponentName: '  Ana Silva ', bestOf: 3, rated: true }),
  ).toEqual({
    opponentName: 'Ana Silva',
    format: { bestOf: 3 },
    rated: true,
  })
})

test.each([
  { name: 'empty', opponentName: '' },
  { name: 'only spaces', opponentName: '   ' },
])(
  'the schema refuses a name that is $name, with the field’s message',
  ({ opponentName }) => {
    const result = newMatchSchema.safeParse({
      opponentName,
      bestOf: 5,
      rated: false,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['opponentName'],
        message: 'Enter your opponent’s name.',
      }),
    ])
  },
)

test.each([0, 2, 4, 9])(
  'the schema refuses best of %i: a match is best of 1, 3, 5 or 7',
  (bestOf) => {
    expect(
      newMatchSchema.safeParse({ opponentName: 'Ana', bestOf, rated: false })
        .success,
    ).toBe(false)
  },
)
