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

for (const opponentName of ['', '   ']) {
  test(`the schema refuses the name ${JSON.stringify(opponentName)}, with the field’s message`, () => {
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
  })
}

test('the schema refuses a length that isn’t best of 1, 3, 5 or 7', () => {
  expect(
    newMatchSchema.safeParse({ opponentName: 'Ana', bestOf: 4, rated: false })
      .success,
  ).toBe(false)
})
