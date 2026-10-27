import { within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LoginGatePage, type FrameSize } from '../../test/pages/LoginGatePage'
import type { LoginGatePath } from './GateGallery'

const sizes: FrameSize[] = ['Phone, 375px', 'Desktop, 1280px']

describe.each<LoginGatePath>(['/login-gate1', '/login-gate2', '/login-gate3'])('%s', (path) => {
  it('shows every frame at phone and desktop width', async () => {
    const page = await LoginGatePage.render(path)

    expect(page.frameTitles).toEqual([
      'Step 1, first sign-in',
      'Step 1, sign-in to an existing account',
      'Step 2',
      'Saving',
      'Error',
      'Toast after Yes, first sign-in',
      'Toast after Yes, existing account',
      'Toast after I manage this player',
      'Toast after Remove from my account',
    ])
    for (const title of page.frameTitles) {
      for (const size of sizes) expect(page.frame(title, size)).toBeInTheDocument()
    }
  })

  it.each(sizes)('asks "Were these yours?" with two answers and no way to skip, at %s', async (size) => {
    const page = await LoginGatePage.render(path)

    const frame = page.frame('Step 1, first sign-in', size)
    expect(within(frame).getByRole('heading', { name: 'Were these yours?' })).toBeInTheDocument()
    expect(page.buttons('Step 1, first sign-in', size).map((button) => button.textContent)).toEqual([
      'Yes, these were mine',
      'Someone else played these',
    ])
  })

  it('shows both players for a sign-in to an existing account', async () => {
    const page = await LoginGatePage.render(path)

    const frame = page.frame('Step 1, sign-in to an existing account', 'Phone, 375px')
    expect(frame).toHaveTextContent('mellow mongoose 594')
    expect(frame).toHaveTextContent('excited egret 387')
  })

  it('asks who played on step 2, with Back', async () => {
    const page = await LoginGatePage.render(path)

    const names = page.buttons('Step 2', 'Phone, 375px').map((button) => button.textContent)
    expect(names[0]).toMatch(/^I manage this player/)
    expect(names[1]).toMatch(/^Remove from my account/)
    expect(names[2]).toBe('Back')
  })

  it('shows progress on the tapped answer and turns the other off while saving', async () => {
    const page = await LoginGatePage.render(path)

    const [yes, other] = page.buttons('Saving', 'Phone, 375px')
    expect(yes).toHaveTextContent('Saving…')
    expect(yes).toHaveAttribute('aria-busy', 'true')
    expect(other).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows the problem and Try again when the answer failed to save', async () => {
    const page = await LoginGatePage.render(path)

    const alert = within(page.frame('Error', 'Phone, 375px')).getByRole('alert')
    expect(alert).toHaveTextContent('Your answer wasn’t saved')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('confirms each answer with a toast that offers Undo', async () => {
    const page = await LoginGatePage.render(path)

    const toast = within(page.frame('Toast after I manage this player', 'Phone, 375px')).getByRole('status')
    expect(toast).toHaveTextContent('You manage mellow mongoose 594 now.')
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})
