import { describe, expect, it } from 'vitest'
import { NotFoundScreenPage } from './NotFoundScreen.page.tsx'

describe('NotFoundScreen', () => {
  it('says the page was not found', async () => {
    const notFound = await NotFoundScreenPage.render()
    expect(notFound.heading).toBeInTheDocument()
  })
})
