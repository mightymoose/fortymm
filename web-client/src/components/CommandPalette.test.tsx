import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette, type Command } from './CommandPalette'

function renderPalette(runs: Record<string, () => void> = {}) {
  const command = (group: string, label: string, extra: Partial<Command> = {}): Command => ({
    group,
    label,
    run: runs[label] ?? (() => {}),
    ...extra,
  })
  const commands = [
    command('Open', 'Match drawer', { keywords: 'sheet side' }),
    command('Open', 'Move match to another table', { keywords: 'bottom sheet' }),
    command('Players', 'Moreau, Élodie', { hint: 'Eastgate' }),
    command('Players', 'Wójcik-Szymańska, Agnieszka', { hint: 'Northside' }),
  ]
  render(<CommandPalette listCommands={() => commands} shortcut />)
}

const search = () => screen.getByRole('combobox', { name: 'Search commands and players' })
const options = () => screen.getAllByRole('option')

describe('CommandPalette', () => {
  it('opens with Ctrl+K or ⌘K, and the shortcut closes it again', async () => {
    const user = userEvent.setup()
    renderPalette()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    expect(search()).toHaveFocus()

    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists every command in its group', async () => {
    const user = userEvent.setup()
    renderPalette()

    await user.keyboard('{Control>}k{/Control}')

    expect(screen.getByRole('group', { name: 'Open' })).toHaveTextContent(
      'Match drawerMove match to another table',
    )
    expect(screen.getByRole('group', { name: 'Players' })).toHaveTextContent(
      'Moreau, ÉlodieEastgateWójcik-Szymańska, AgnieszkaNorthside',
    )
  })

  it('finds commands by label, hint and keywords, ignoring accents', async () => {
    const user = userEvent.setup()
    renderPalette()
    await user.keyboard('{Control>}k{/Control}')

    await user.type(search(), 'elodie')
    expect(options()).toHaveLength(1)
    expect(options()[0]).toHaveTextContent('Moreau, Élodie')

    await user.clear(search())
    await user.type(search(), 'northside')
    expect(options()[0]).toHaveTextContent('Wójcik-Szymańska, Agnieszka')

    await user.clear(search())
    await user.type(search(), 'sheet')
    expect(options()).toHaveLength(2)
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    renderPalette()
    await user.keyboard('{Control>}k{/Control}')

    await user.type(search(), 'zz')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('No commands or players match “zz”.')).toBeVisible()
  })

  it('moves the active command with the arrow keys, wrapping around', async () => {
    const user = userEvent.setup()
    renderPalette()
    await user.keyboard('{Control>}k{/Control}')
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(search()).toHaveAttribute('aria-activedescendant', options()[0].id)

    await user.keyboard('{ArrowUp}')
    expect(options()[3]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    expect(search()).toHaveAttribute('aria-activedescendant', options()[1].id)
  })

  it('closes, then runs the active command, on Enter', async () => {
    const run = vi.fn()
    const user = userEvent.setup()
    renderPalette({ 'Move match to another table': run })
    await user.keyboard('{Control>}k{/Control}')

    await user.keyboard('{ArrowDown}{Enter}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it('runs a command on a click', async () => {
    const run = vi.fn()
    const user = userEvent.setup()
    renderPalette({ 'Match drawer': run })
    await user.keyboard('{Control>}k{/Control}')

    await user.click(screen.getByRole('option', { name: 'Match drawer' }))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
  })
})
