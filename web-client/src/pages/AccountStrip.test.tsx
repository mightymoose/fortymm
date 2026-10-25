import { describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'

describe('AccountStrip', () => {
  it('asks a guest to sign in, and brings them back to this page', async () => {
    const homePage = await HomePage.render()

    expect(homePage.signInStrip).toHaveTextContent(
      'Playing as a guest. Sign in to use this account on any device.',
    )
    expect(homePage.signInLink).toHaveAttribute('href', '/api/v1/auth/login?return_to=%2F')
  })

  it("keeps the page's query in the way back", async () => {
    const homePage = await HomePage.render({ path: '/?tab=leagues' })

    expect(homePage.signInLink).toHaveAttribute(
      'href',
      '/api/v1/auth/login?return_to=%2F%3Ftab%3Dleagues',
    )
  })
})
