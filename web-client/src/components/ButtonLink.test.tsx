import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { renderScreen } from '../test/render-screen.tsx'
import { ButtonLink } from './ButtonLink.tsx'

test('a button link is a link, named by its content, to its page', async () => {
  renderScreen(
    <ButtonLink to="/matches/new" variant="primary">
      New match
    </ButtonLink>,
  )

  expect(
    await screen.findByRole('link', { name: 'New match' }),
  ).toHaveAttribute('href', '/matches/new')
  expect(screen.queryByRole('button')).toBeNull()
})
