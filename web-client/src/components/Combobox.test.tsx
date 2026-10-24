import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCE_DELAY_MS, Combobox, type ComboboxHandle } from './Combobox'
import { ToastProvider } from './ToastProvider'

const players = [
  { name: 'Nguyen, Thanh', club: 'Riverside TT', rating: '2,145' },
  { name: 'Nguyen, Linh', club: 'Eastgate', rating: '1,702' },
  { name: 'Wójcik-Szymańska, Agnieszka', club: 'Northside', rating: '2,088' },
  { name: 'Moreau, Élodie', club: 'Eastgate', rating: '1,930' },
]

function renderCombobox() {
  const onChange = vi.fn()
  const handle = createRef<ComboboxHandle>()
  render(
    <ToastProvider>
      <label htmlFor="opponent">Opponent</label>
      <Combobox ref={handle} id="opponent" label="Opponent" options={players} onChange={onChange} />
    </ToastProvider>,
  )
  return { onChange, handle }
}

const field = () => screen.getByRole('combobox', { name: 'Opponent' })
const names = () =>
  screen.queryAllByRole('option').map((option) => option.querySelector('b')!.textContent)

describe('Combobox', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists every player on a click', async () => {
    const user = userEvent.setup()
    renderCombobox()

    await user.click(field())

    expect(screen.getByRole('listbox', { name: 'Opponent' })).toBeVisible()
    expect(field()).toHaveAttribute('aria-expanded', 'true')
    expect(names()).toHaveLength(4)
  })

  it.each([
    ['ngu', ['Nguyen, Thanh', 'Nguyen, Linh']],
    ['linh', ['Nguyen, Linh']],
    ['wojcik', ['Wójcik-Szymańska, Agnieszka']],
    ['elodie', ['Moreau, Élodie']],
    ['eastgate', ['Nguyen, Linh', 'Moreau, Élodie']],
  ])('finds %s by surname, first name or club, ignoring accents', async (query, found) => {
    const user = userEvent.setup()
    renderCombobox()

    await user.type(field(), query)

    expect(names()).toEqual(found)
  })

  it('bolds the part of the name that matches', async () => {
    const user = userEvent.setup()
    renderCombobox()

    await user.type(field(), 'wojcik')

    expect(screen.getByRole('option').querySelector('mark')).toHaveTextContent('Wójcik')
  })

  it('says when no player matches', async () => {
    const user = userEvent.setup()
    renderCombobox()

    await user.type(field(), 'zz')

    expect(screen.getByRole('listbox')).toHaveTextContent(
      'No players match “zz”. Check the spelling or search by club.',
    )
  })

  it('moves with ↓ and ↑, and Enter picks the active player', async () => {
    const user = userEvent.setup()
    const { onChange } = renderCombobox()

    await user.type(field(), 'ngu')
    expect(field()).toHaveAttribute('aria-activedescendant', 'opponent-o0')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Nguyen, Linh')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Nguyen, Thanh')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Nguyen, Linh')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith(players[1])
    expect(field()).toHaveValue('Nguyen, Linh')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('picks a player on a click and ticks them when the list opens again', async () => {
    const user = userEvent.setup()
    const { onChange } = renderCombobox()
    await user.type(field(), 'moreau')

    await user.click(screen.getByRole('option'))
    expect(onChange).toHaveBeenCalledWith(players[3])
    await user.click(field())

    expect(screen.getByRole('option').querySelector('.ck svg')).toBeInTheDocument()
  })

  it('closes on Esc, and a second Esc clears the field', async () => {
    const user = userEvent.setup()
    renderCombobox()
    await user.type(field(), 'ngu')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field()).toHaveValue('ngu')

    await user.keyboard('{Escape}')
    expect(field()).toHaveValue('')
  })

  it('searches for a player through its handle', () => {
    const { handle } = renderCombobox()

    act(() => handle.current!.search('Moreau, Élodie'))

    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('Moreau, Élodie')
    expect(names()).toEqual(['Moreau, Élodie'])
  })

  it('announces how many players it found once typing stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderCombobox()

    await user.type(field(), 'ngu')
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS + 40))

    expect(screen.getByText('2 players found')).toBeInTheDocument()
  })
})
