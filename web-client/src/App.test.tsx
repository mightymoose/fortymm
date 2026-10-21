import { describe, expect, it } from 'vitest'
import { HomePage } from './test/pages/HomePage'

describe('App', () => {
  it('shows the FortyMM title', () => {
    const homePage = HomePage.render()

    expect(homePage.title).toHaveTextContent('FortyMM')
  })
})
