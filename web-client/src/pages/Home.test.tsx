import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HomePage } from '../test/pages/HomePage'

describe('Home', () => {
  it('shows the FortyMM title', async () => {
    const homePage = await HomePage.render()

    expect(homePage.title).toHaveTextContent('FortyMM')
  })

  it('links to the design system page', async () => {
    const homePage = await HomePage.render()

    await userEvent.click(homePage.designSystemLink)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Design System' }),
    ).toBeInTheDocument()
  })
})
