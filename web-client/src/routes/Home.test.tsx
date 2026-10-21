import { describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'

describe('Home', () => {
  it('shows the FortyMM title', async () => {
    const homePage = await HomePage.render()

    expect(homePage.title).toHaveTextContent('FortyMM')
  })
})
