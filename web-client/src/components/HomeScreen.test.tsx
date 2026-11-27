import { describe, expect, it } from 'vitest'
import { HomeScreenPage } from './HomeScreen.page.tsx'

describe('HomeScreen', () => {
  it('shows the app name', () => {
    const home = HomeScreenPage.render()
    expect(home.heading).toBeInTheDocument()
  })
})
