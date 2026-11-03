import { waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import vectors from '../../../../api/signed-results/vectors.json'
import { ResultLinkPage } from '../../test/pages/ResultLinkPage'

const vector = vectors.valid.find((candidate) => candidate.name === 'retired-mid-match')!

describe('ResultLink', () => {
  it('shows what a result link holds', async () => {
    const page = await ResultLinkPage.render(vector.link.replace('https://fortymm.com', ''))

    expect(page.heading).toHaveTextContent('Signed match result')
    expect(page.value('Match')).toBe(vector.result.match)
    expect(page.value('Best of')).toBe('5')
    expect(page.value('Rated')).toBe('Yes')
    expect(page.value('Player 1')).toBe(vector.result.players[0])
    expect(page.value('Player 2')).toBe(vector.result.players[1])
    expect(page.value('Games')).toBe('11–8, 7–5')
    expect(page.value('Ending')).toBe('Retired by player 2')
    expect(page.value('Replaces')).toBe('None')
    expect(page.value('Issued at')).toBe(new Date(vector.issued_at * 1000).toISOString())
    expect(page.value('Signature 1')).toBe(`Player 1, key ${vector.signatures[0].kid}`)
    expect(page.value('Signature 2')).toBe(`Player 2, key ${vector.signatures[1].kid}`)
    await waitFor(() => expect(page.value('Result hash')).toBe(vector.hash))
  })

  it.each(['/r', '/r#not-a-result'])('says %s isn’t a result', async (path) => {
    const page = await ResultLinkPage.render(path)

    expect(page.heading).toHaveTextContent('This link isn’t a FortyMM result')
  })
})
