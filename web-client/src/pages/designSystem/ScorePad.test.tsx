import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../../components/ToastProvider'
import { ScorePad } from './ScorePad'

function renderPad() {
  render(
    <ToastProvider>
      <ScorePad
        players={[{ name: 'Patel, Meera' }, { name: 'Wójcik-Szymańska, Agnieszka' }]}
        start={{ games: [[11, 8], [6, 11], [11, 9], [9, 11]], points: [9, 9], serve: 1 }}
        bestOf={5}
      />
    </ToastProvider>,
  )
}

const button = (name: string) => screen.getByRole('button', { name })
const points = (name: string) => screen.getByLabelText(`${name} points`)
const servers = () => screen.queryAllByRole('img', { name: 'Serving' })
const toasts = () => screen.getByRole('status', { name: 'Notifications' })
const history = () =>
  screen.getByRole('table', {
    name: 'Game scores, Patel, Meera vs Wójcik-Szymańska, Agnieszka',
  })

describe('ScorePad', () => {
  it('opens on the score it is given, with nothing to undo', () => {
    renderPad()

    expect(points('Patel')).toHaveTextContent('9')
    expect(points('Wójcik-Szymańska')).toHaveTextContent('9')
    expect(servers()).toHaveLength(1)
    expect(screen.getByText('Wójcik-Szymańska, Agnieszka').parentElement).toContainElement(
      servers()[0],
    )
    expect(button('Undo last point')).toBeDisabled()
    expect(within(history()).getByRole('columnheader', { name: 'Game 5 · now' })).toBeVisible()
  })

  it('adds a point, flashes the number it changed and reads the score out', async () => {
    const user = userEvent.setup()
    renderPad()

    await user.click(button('+1 Patel'))

    expect(points('Patel')).toHaveTextContent('10')
    expect(points('Patel')).toHaveClass('score-updated')
    expect(points('Wójcik-Szymańska')).not.toHaveClass('score-updated')
    expect(await screen.findByText('Patel 10, Wójcik-Szymańska 9')).toBeInTheDocument()
    expect(within(history()).getAllByRole('row')[1]).toHaveTextContent('Patel11611910')
  })

  it('changes the serve every point from 10–10', async () => {
    const user = userEvent.setup()
    renderPad()
    const servingName = () => servers()[0].previousElementSibling

    await user.click(button('+1 Patel'))
    expect(servingName()).toHaveTextContent('Wójcik-Szymańska, Agnieszka')
    await user.click(button('+1 Wójcik-Szymańska'))
    expect(servingName()).toHaveTextContent('Patel, Meera')
    await user.click(button('+1 Patel'))
    expect(servingName()).toHaveTextContent('Wójcik-Szymańska, Agnieszka')
  })

  it('takes the last point back, and says so', async () => {
    const user = userEvent.setup()
    renderPad()
    await user.click(button('+1 Wójcik-Szymańska'))

    await user.click(button('Undo last point'))

    expect(points('Wójcik-Szymańska')).toHaveTextContent('9')
    expect(button('Undo last point')).toBeDisabled()
    expect(await screen.findByText('Last point undone')).toBeInTheDocument()
  })

  it('wins the game and the match, and the toast’s Undo takes the winning point back', async () => {
    const user = userEvent.setup()
    renderPad()
    await user.click(button('+1 Patel'))
    await user.click(button('+1 Patel'))

    expect(toasts()).toHaveTextContent('Game 5 to Patel, 11–9')
    expect(points('Patel')).toHaveTextContent('0')
    expect(button('+1 Patel')).toBeDisabled()
    expect(button('+1 Wójcik-Szymańska')).toBeDisabled()

    await user.click(within(toasts()).getByRole('button', { name: 'Undo' }))

    expect(points('Patel')).toHaveTextContent('10')
    expect(points('Wójcik-Szymańska')).toHaveTextContent('9')
    expect(button('+1 Patel')).toBeEnabled()
    expect(within(history()).getByRole('columnheader', { name: 'Game 5 · now' })).toBeVisible()
  })

  it('leaves the score alone when the winning point was already taken back', async () => {
    const user = userEvent.setup()
    renderPad()
    await user.click(button('+1 Patel'))
    await user.click(button('+1 Patel'))
    await user.click(button('Undo last point'))

    await user.click(within(toasts()).getByRole('button', { name: 'Undo' }))

    expect(points('Patel')).toHaveTextContent('10')
  })
})
