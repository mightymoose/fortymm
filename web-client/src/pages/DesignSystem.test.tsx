import { act, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
import { TOOLTIP_DELAY_MS } from '../components/TooltipProvider'
import { BUSY_MS } from './designSystem/BusyDemoButton'

describe('DesignSystem', () => {
  it('shows the Design System title', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.title).toHaveTextContent('Design System')
  })

  it('introduces the design system under the title', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.intro).toHaveTextContent(
      /^Equipment for running a tournament day\./,
    )
  })

  describe('Roles at a glance', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('comes first, before Buttons', async () => {
      const designSystemPage = await DesignSystemPage.render()

      expect(
        designSystemPage.rolesSection.compareDocumentPosition(designSystemPage.buttonsSection),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it('shows Retrying… while Retry now retries, then its label again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const designSystemPage = await DesignSystemPage.render()
      const button = designSystemPage.rolesButton('Retry now')

      await user.click(button)

      expect(button).toHaveAccessibleName('Retrying…')
      expect(button).toHaveAttribute('aria-busy', 'true')
      act(() => vi.advanceTimersByTime(BUSY_MS))
      expect(button).toHaveAccessibleName('Retry now')
      expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
    })

    it.each(["I'm at the table", 'Directions', 'Move to 12:05', 'Keep 11:50', 'Undo'])(
      'does nothing on %s, which is visual only',
      async (name) => {
        const user = userEvent.setup()
        const designSystemPage = await DesignSystemPage.render()

        await user.click(designSystemPage.rolesButton(name))

        expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
        expect(designSystemPage.rolesButton(name)).toBeInTheDocument()
      },
    )
  })

  describe('Buttons', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      'Call to table',
      'Reschedule',
      'Print score sheet',
      'Withdraw player…',
      'Small',
      'Default',
      'Large',
      'More options',
    ])('shows a %s button', async (name) => {
      const designSystemPage = await DesignSystemPage.render()

      expect(designSystemPage.button(name)).toBeEnabled()
    })

    it.each([
      ['Save result', 'Saving…'],
      ['Export results', 'Exporting…'],
    ])('%s shows %s while it saves, then its label again', async (label, busyLabel) => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const designSystemPage = await DesignSystemPage.render()

      const button = designSystemPage.button(label)

      await user.click(button)

      expect(button).toHaveAccessibleName(busyLabel)
      expect(button).toHaveAttribute('aria-busy', 'true')
      act(() => vi.advanceTimersByTime(BUSY_MS))
      expect(button).toHaveAccessibleName(label)
      expect(button).not.toHaveAttribute('aria-busy')
    })

    it('says the result is saved once Save result is done', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const designSystemPage = await DesignSystemPage.render()

      await user.click(designSystemPage.button('Save result'))
      expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
      act(() => vi.advanceTimersByTime(BUSY_MS))

      expect(designSystemPage.toastRegion).toHaveTextContent(
        'Result saved. Okafor-Adeyemi ▲ +9',
      )
    })

    it('shows More options in a tooltip on hover', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const designSystemPage = await DesignSystemPage.render()
      const moreOptions = designSystemPage.button('More options')

      await user.hover(moreOptions)
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

      expect(designSystemPage.tooltip).toHaveTextContent('More options')
      expect(moreOptions).toHaveAccessibleDescription('More options')
    })

    it('asks before Withdraw player… withdraws', async () => {
      const user = userEvent.setup()
      const designSystemPage = await DesignSystemPage.render()

      await user.click(designSystemPage.button('Withdraw player…'))

      expect(
        designSystemPage.dialog('Withdraw Okafor-Adeyemi from the draw?'),
      ).toHaveTextContent(
        "Johansen-Whitfield advances to the quarterfinal. This can't be undone once her next match starts.",
      )
    })

    it('says why Start match is off', async () => {
      const designSystemPage = await DesignSystemPage.render()
      const startMatch = designSystemPage.button('Start match')

      expect(startMatch).toHaveAttribute('aria-disabled', 'true')
      expect(startMatch).toHaveAccessibleDescription(
        "Both players need to check in first. Park hasn't yet.",
      )
    })
  })
})

describe('Fields and choices', () => {
  it('shows the Table error until the table is 1 to 6', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Text field')
    const table = within(example).getByRole('textbox', { name: 'Table' })
    expect(table).toBeInvalid()
    expect(table).toHaveAccessibleDescription('This venue has 6 tables. Enter 1–6.')

    await user.clear(table)
    await user.type(table, '4')

    expect(table).toBeValid()
    expect(within(example).queryByText('This venue has 6 tables. Enter 1–6.')).not.toBeVisible()
  })

  it('finds Spring Open 2026 by its code', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Code input')
    const found = within(example).getByText('Spring Open 2026').closest('p')!
    expect(found).not.toBeVisible()

    await user.click(within(example).getAllByRole('textbox', { name: 'Character 1 of 6' })[0])
    await user.keyboard('sp26rv')

    expect(found).toBeVisible()
    expect(found).toHaveTextContent('Spring Open 2026 · Riverside Sports Hall · 11 April')
  })

  it('says no tournament uses an unknown code, until the code changes', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Code input')
    const first = within(example).getAllByRole('textbox', { name: 'Character 1 of 6' })[0]

    await user.click(first)
    await user.keyboard('sp26rx')

    expect(first).toBeInvalid()
    expect(first).toHaveAccessibleDescription(
      'No tournament uses that code. Check the poster or ask the desk. On the poster at the venue entrance. Try SP26RV.',
    )
    await user.keyboard('{Backspace}')
    expect(first).toBeValid()
    expect(first).toHaveAccessibleDescription('On the poster at the venue entrance. Try SP26RV.')
  })

  it('leaves the closed tournament’s code input off', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Code input')
    const closed = within(example).getAllByRole('textbox', { name: 'Character 1 of 6' })[1]

    expect(closed).toBeDisabled()
    expect(closed).toHaveAccessibleDescription('Entries for this tournament have closed.')
  })

  it('says who was picked as the opponent', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Combobox')
    expect(example).toHaveTextContent('Nothing picked yet.')

    await user.type(designSystemPage.opponentField, 'wojcik{Enter}')

    expect(example).toHaveTextContent('Picked: Wójcik-Szymańska, Agnieszka · Northside')
  })

  it('shows Saturday 11 April 2026 in the date field and selected inline', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Date picker')

    expect(within(example).getByRole('textbox', { name: 'Tournament date' })).toHaveValue(
      'Saturday 11 April 2026',
    )
    expect(
      within(example).getByRole('button', { name: 'Saturday 11 April 2026' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('shows All players as partly checked', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Checkbox, radio and switch')

    expect(within(example).getByRole('checkbox', { name: 'All players (12 of 16)' })).toBePartiallyChecked()
  })

  it('shows the minimum rest as the slider moves', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Checkbox, radio and switch')
    const slider = within(example).getByRole('slider')

    fireEvent.change(slider, { target: { value: '25' } })

    expect(slider).toHaveAccessibleName('Minimum rest between matches · 25 min')
  })

  it('turns a switch on', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.fieldsExample('Checkbox, radio and switch')
    const ratings = within(example).getByRole('switch', { name: 'Show ratings to spectators' })

    await user.click(ratings)

    expect(ratings).toBeChecked()
  })
})

describe('Selection', () => {
  it('shows the panel of the tab picked by click or arrow key', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const section = designSystemPage.selectionSection
    expect(within(section).getByRole('tabpanel')).toHaveTextContent(
      '32 players · 4 tables · expected finish 18:45',
    )

    await user.click(designSystemPage.selectionControl('tab', 'Standings'))
    expect(within(section).getByRole('tabpanel')).toHaveTextContent(
      'Groups A–D, top two advance.',
    )
    await user.keyboard('{ArrowLeft}')

    expect(designSystemPage.selectionControl('tab', 'Schedule')).toHaveFocus()
    expect(within(section).getByRole('tabpanel', { name: 'Schedule' })).toHaveTextContent(
      '14 of 31 matches played.',
    )
  })

  it('changes the schedule view', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.selectionControl('radio', 'By player'))

    expect(designSystemPage.selectionControl('radio', 'By player')).toBeChecked()
    expect(designSystemPage.selectionControl('radio', 'Timeline')).not.toBeChecked()
  })

  it('says which events the filter chips show', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const section = designSystemPage.selectionSection
    expect(within(section).getByText(/^Showing:/)).toHaveTextContent('Showing: All events')

    await user.click(designSystemPage.selectionControl('button', 'Under 18'))
    await user.click(designSystemPage.selectionControl('button', 'Open singles'))
    expect(within(section).getByText(/^Showing:/)).toHaveTextContent(
      'Showing: Open singles, Under 18',
    )

    await user.click(designSystemPage.selectionControl('button', 'All events'))
    expect(within(section).getByText(/^Showing:/)).toHaveTextContent('Showing: All events')
  })

  it('turns calling players automatically off', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const calling = designSystemPage.selectionControl('switch', 'Call players automatically')
    expect(calling).toBeChecked()

    await user.click(calling)

    expect(calling).not.toBeChecked()
  })
})

describe('Containers', () => {
  it.each(['Move table', 'View matches', 'Message'])(
    'says %s is not wired up in this demo',
    async (name) => {
      const user = userEvent.setup()
      const designSystemPage = await DesignSystemPage.render()

      await user.click(designSystemPage.containersButton(name))

      expect(designSystemPage.toastRegion).toHaveTextContent(
        `“${name}” isn’t wired up in this demo`,
      )
    },
  )

  it('checks everyone in, and Undo puts the boxes back', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const players = within(designSystemPage.containersExample('Scroll area'))
    const notHere = ['Kim, Hyun-woo', 'Lindqvist, Erik', 'Fernández-Castillo, Marisol']

    await user.click(designSystemPage.containersButton('Check in all'))

    expect(players.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(
      true,
    )
    expect(designSystemPage.toastRegion).toHaveTextContent('3 more players checked in')

    await user.click(designSystemPage.toastButton('Undo'))

    for (const name of notHere) {
      expect(players.getByRole('checkbox', { name })).not.toBeChecked()
    }
    expect(players.getByRole('checkbox', { name: 'Moreau, Élodie' })).toBeChecked()
  })

  it('says when everyone was already checked in, with no Undo', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const players = within(designSystemPage.containersExample('Scroll area'))
    for (const name of ['Kim, Hyun-woo', 'Lindqvist, Erik', 'Fernández-Castillo, Marisol']) {
      await user.click(players.getByRole('checkbox', { name }))
    }

    await user.click(designSystemPage.containersButton('Check in all'))

    expect(designSystemPage.toastRegion).toHaveTextContent('Everyone was already checked in')
    expect(
      within(designSystemPage.toastRegion).queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument()
  })

  it('shows the match of the block picked in the schedule', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const splitView = within(designSystemPage.containersExample('Split view'))
    expect(splitView.getByRole('region', { name: 'Patel vs Park' })).toHaveTextContent(
      'Patel would get 5 minutes’ rest',
    )

    await user.click(designSystemPage.containersButton(/Okafor-Adeyemi, Daniel vs/))

    const details = splitView.getByRole('region', { name: 'Okafor-Adeyemi vs Johansen-Whitfield' })
    expect(within(details).getByRole('link', { name: 'Open scoring' })).toHaveAttribute(
      'href',
      'https://github.com/mightymoose/fortymm/blob/main/references/design-system/ui_kits/tournament/mobile.html',
    )
    expect(
      within(details).getByRole('table', {
        name: 'Game scores, Okafor-Adeyemi, Daniel vs Johansen-Whitfield, Annika',
      }),
    ).toBeVisible()
  })

  it('says the conflict’s fix works on the tournament screen', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.containersButton('Move to 12:05'))

    expect(designSystemPage.toastRegion).toHaveTextContent(
      'Works on the tournament screen, not in this gallery',
    )
  })

  it('opens the withdraw-a-player dialog from an upcoming match, and Cancel closes it', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    await user.click(designSystemPage.containersButton(/Chen, Wei vs Ali, Rashid/))

    await user.click(designSystemPage.containersButton('Withdraw a player…'))
    const dialog = designSystemPage.dialog('Withdraw a player from this match?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(designSystemPage.openDialogs).toEqual([])
  })

  it('keeps Call to table off while Lindqvist rests', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    await user.click(designSystemPage.containersButton(/Dubois, Camille vs Lindqvist, Erik/))

    await user.click(designSystemPage.containersButton('Call to table'))

    expect(designSystemPage.containersButton('Call to table')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
  })
})

describe('Feedback', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls Chen vs Ali, and Undo calls the match back', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.feedbackButton('Call Chen vs Ali'))

    const called = designSystemPage.feedbackButton('Called · Table 1')
    expect(called).toHaveAttribute('aria-disabled', 'true')
    expect(designSystemPage.toastRegion).toHaveTextContent('Chen vs Ali called to Table 1')

    await user.click(designSystemPage.toastButton('Undo'))

    const call = designSystemPage.feedbackButton('Call Chen vs Ali')
    expect(call).not.toHaveAttribute('aria-disabled')
    expect(call).toHaveFocus()
    expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
  })

  it('marks Table 4 free, with no Undo', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.feedbackButton('Mark Table 4 free'))

    expect(designSystemPage.toastRegion).toHaveTextContent('Table 4 marked free')
    expect(
      within(designSystemPage.toastRegion).queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument()
  })

  it('moves the doubles, and Undo brings the warning back', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = designSystemPage.feedbackExample('Warning and error')
    const warning = within(example).getByText(
      'Okafor-Adeyemi is booked on two tables at 12:00',
    )
    const resolved = within(example).getByText(
      'Doubles moved to 12:40. Okafor-Adeyemi has 5 minutes between his matches.',
    )
    expect(resolved).not.toBeVisible()

    await user.click(designSystemPage.feedbackButton('Move doubles to 12:40'))

    expect(warning).not.toBeVisible()
    expect(resolved).toBeVisible()
    expect(designSystemPage.toastRegion).toHaveTextContent('Doubles moved to 12:40')

    await user.click(designSystemPage.toastButton('Undo'))

    expect(warning).toBeVisible()
    expect(resolved).not.toBeVisible()
    expect(designSystemPage.feedbackButton('Move doubles to 12:40')).toHaveFocus()
  })

  it('shows the error as an alert', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      within(designSystemPage.feedbackSection).getByRole('alert'),
    ).toHaveTextContent(/^Table 4 scorer is offline/)
  })

  it.each(['Choose another time', 'Score from this device'])(
    'says %s is not wired up in this demo',
    async (name) => {
      const user = userEvent.setup()
      const designSystemPage = await DesignSystemPage.render()

      await user.click(designSystemPage.feedbackButton(name))

      expect(designSystemPage.toastRegion).toHaveTextContent(
        `“${name}” isn’t wired up in this demo`,
      )
    },
  )

  it('shows Sending… while Send a reminder sends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const designSystemPage = await DesignSystemPage.render()
    const button = designSystemPage.feedbackButton('Send a reminder')

    await user.click(button)

    expect(button).toHaveAccessibleName('Sending…')
    act(() => vi.advanceTimersByTime(BUSY_MS))
    expect(button).toHaveAccessibleName('Send a reminder')
    expect(designSystemPage.toastRegion).toBeEmptyDOMElement()
  })
})

describe('Overlays', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows each tooltip trigger’s tooltip on hover', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const designSystemPage = await DesignSystemPage.render()

    await user.hover(designSystemPage.overlaysButton('Move to free table'))
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))

    expect(designSystemPage.tooltip).toHaveTextContent(
      'Moves this match to the next free table and tells both players. Their rest times are kept.',
    )
  })

  it('opens the withdraw dialog, and Keep in draw closes it', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.overlaysButton('Withdraw player…'))
    const dialog = designSystemPage.dialog('Withdraw Okafor-Adeyemi from the draw?')
    await user.click(within(dialog).getByRole('button', { name: 'Keep in draw' }))

    expect(designSystemPage.openDialogs).toEqual([])
  })

  it('opens the match drawer on Patel vs Wójcik-Szymańska', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.overlaysButton('Open match drawer'))

    const drawer = designSystemPage.dialog('Patel vs Wójcik-Szymańska')
    expect(drawer).toHaveTextContent('Table 3 · Open singles · Round of 32')
    expect(
      within(drawer).getByRole('article', {
        name: 'Patel, Meera vs Wójcik-Szymańska, Agnieszka',
      }),
    ).toBeVisible()
    expect(
      within(drawer).getByRole('table', {
        name: 'Game scores, Patel, Meera vs Wójcik-Szymańska, Agnieszka',
      }),
    ).toBeVisible()
    expect(within(drawer).getByRole('link', { name: 'Open scoring' })).toHaveAttribute(
      'href',
      'https://github.com/mightymoose/fortymm/blob/main/references/design-system/ui_kits/tournament/mobile.html',
    )
  })

  it('offers the tables the match isn’t on, with Table 4 off while its scorer is offline', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.overlaysButton('Move match to another table…'))

    const sheet = designSystemPage.dialog('Move to another table')
    const tables = within(sheet).getAllByRole('radio')
    expect(tables.map((table) => table.getAttribute('value'))).toEqual([
      'Table 2',
      'Table 5',
      'Table 4',
    ])
    expect(tables[0]).toBeChecked()
    expect(tables[2]).toBeDisabled()
  })

  it('shows the match actions menu, its destructive command last', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const menu = within(designSystemPage.overlaysSection).getByRole('menu', {
      name: 'Match actions',
    })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit match',
      'Move to another table',
      'Print score sheet⌘P',
      'Remove from schedule',
    ])
  })

  it('opens the command palette from its button', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.overlaysButton('Search commands'))

    expect(designSystemPage.paletteSearch).toHaveFocus()
  })

  it('lists only the sections the page has under Go to', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.keyboard('{Control>}k{/Control}')

    expect(
      within(designSystemPage.paletteGroup('Go to'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Roles at a glance',
      'Buttons',
      'Fields, dates and choices',
      'Selection',
      'Containers',
      'Feedback',
      'Overlays',
      'Match components',
      'More components',
    ])
  })

  it('goes to a section from the palette', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    await user.keyboard('{Control>}k{/Control}')

    await user.type(designSystemPage.paletteSearch, 'feedback{Enter}')

    await waitFor(() =>
      expect(
        within(designSystemPage.feedbackSection).getByRole('heading', { level: 2 }),
      ).toHaveFocus(),
    )
  })

  it('opens the withdraw dialog from the palette', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    await user.keyboard('{Control>}k{/Control}')

    await user.type(designSystemPage.paletteSearch, 'withdraw{Enter}')

    expect(
      await within(document.body).findByRole('dialog', {
        name: 'Withdraw Okafor-Adeyemi from the draw?',
      }),
    ).toBeVisible()
  })

  it('finds a player from the palette in the opponent combobox', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    await user.keyboard('{Control>}k{/Control}')

    await user.type(designSystemPage.paletteSearch, 'patel{Enter}')

    await waitFor(() => expect(designSystemPage.opponentField).toHaveFocus())
    expect(designSystemPage.opponentField).toHaveValue('Patel, Meera')
    expect(
      within(within(designSystemPage.fieldsSection).getByRole('listbox', { name: 'Opponent' }))
        .getAllByRole('option')
        .map((option) => option.querySelector('b')!.textContent),
    ).toEqual(['Patel, Meera'])
  })
})

describe('Match components', () => {
  it('shows a match row in each state', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const rows = within(designSystemPage.matchExample('Match row'))

    for (const [name, status] of [
      ['Okafor-Adeyemi, Daniel vs Johansen-Whitfield, Annika', 'Live'],
      ['Patel, Meera vs Wójcik-Szymańska, Agnieszka', 'Live'],
      ['Dubois, Camille vs Lindqvist, Erik', '12:15'],
      ['Nguyen, Thanh vs Silva, Rafael', 'Final'],
      ['Patel, Meera vs Park, Ji-ho', 'Needs decision'],
    ]) {
      expect(rows.getByRole('article', { name })).toHaveTextContent(status)
    }
    expect(
      within(designSystemPage.matchExample('Empty and disconnected')).getByRole('article', {
        name: 'Rossi, Giulia / Haddad, Youssef vs Fernández-Castillo, Marisol / Kim, Hyun-woo',
      }),
    ).toHaveTextContent('Scorer offline')
  })

  it('shows a match’s game scores from its row', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const row = within(
      within(designSystemPage.matchExample('Match row')).getByRole('article', {
        name: 'Nguyen, Thanh vs Silva, Rafael',
      }),
    )

    await user.click(row.getByRole('button', { name: 'Game scores' }))

    expect(
      row.getByRole('table', { name: 'Game scores, Nguyen, Thanh vs Silva, Rafael' }),
    ).toBeVisible()
  })

  it('says Assign a match is not wired up in this demo', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()

    await user.click(designSystemPage.matchButton('Assign a match'))

    expect(designSystemPage.toastRegion).toHaveTextContent(
      '“Assign a match” isn’t wired up in this demo',
    )
  })

  it('scores the deciding game, and the toast’s Undo takes the winning point back', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const pad = within(designSystemPage.matchExample('Score entry and game history'))

    await user.click(designSystemPage.matchButton('+1 Wójcik-Szymańska'))
    await user.click(designSystemPage.matchButton('+1 Wójcik-Szymańska'))

    expect(designSystemPage.toastRegion).toHaveTextContent('Game 5 to Wójcik-Szymańska, 11–9')
    expect(designSystemPage.matchButton('+1 Patel')).toBeDisabled()

    await user.click(designSystemPage.toastButton('Undo'))

    expect(pad.getByLabelText('Wójcik-Szymańska points')).toHaveTextContent('10')
    expect(designSystemPage.matchButton('+1 Patel')).toBeEnabled()
  })

  it('starts with no schedule block pressed, and presses the one picked', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const blocks = within(designSystemPage.matchExample('Schedule blocks'))
    expect(blocks.queryAllByRole('button', { pressed: true })).toEqual([])

    await user.click(blocks.getByRole('button', { name: /Nguyen, Thanh vs Silva, Rafael/ }))

    expect(blocks.getByRole('button', { name: /Nguyen, Thanh vs Silva, Rafael/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await within(document.body).findByText('Nguyen vs Silva, selected')).toBeInTheDocument()
  })

  it('shows the rest left at the schedule’s 11:47', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const rest = within(designSystemPage.matchExample('Rest indicator'))

    expect(rest.getByText('8 min left')).toBeVisible()
    const meter = rest.getByRole('progressbar', { name: 'Rest elapsed' })
    expect(meter).toHaveAttribute('aria-valuenow', '7')
    expect(meter).toHaveAttribute('aria-valuemax', '15')
  })
})

describe('More components', () => {
  it('shows the players’ numbers and signed rating changes in the data table', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const table = within(designSystemPage.moreExample('Data table')).getByRole('table')

    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => [...(row as HTMLTableRowElement).cells].map((cell) => cell.textContent)),
    ).toEqual([
      ['Player', 'Club', 'Played', 'Rating', 'Change'],
      ['Nguyen, Thanh', 'Riverside TT', '42', '2,145', '▲ +12'],
      ['Wójcik-Szymańska, Agnieszka', 'Northside', '37', '2,088', '▲ +4'],
      ['Okafor-Adeyemi, Daniel', 'Eastgate', '51', '1,987', '▼ −12'],
    ])
  })

  it('shows the Round of 16 as 5 of 8 played', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = within(designSystemPage.moreExample('Tags, avatar, progress'))

    const progress = example.getByRole('progressbar', { name: 'Round of 16 progress' })
    expect(progress).toHaveAttribute('aria-valuenow', '5')
    expect(progress).toHaveAttribute('aria-valuemax', '8')
  })

  it('links its navigation to the section itself, since the pages it names don’t exist', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = within(designSystemPage.moreExample('Navigation'))

    const links = example.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Spring Open',
      'Open singles',
      'Tables & schedule',
      'Draws',
      'Players',
      'Results',
    ])
    for (const link of links) expect(link).toHaveAttribute('href', '#more')
    expect(
      within(example.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Round of 16'),
    ).toHaveAttribute('aria-current', 'page')
    expect(example.getByRole('link', { name: 'Tables & schedule' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('says which menubar command was chosen, and nothing else happens', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = within(designSystemPage.moreExample('Menubar'))
    expect(example.getByText('Demo: choosing a command only shows its name here.')).toBeVisible()

    await user.click(example.getByRole('menuitem', { name: 'Tournament' }))
    await user.click(example.getByRole('menuitem', { name: /^Print entry list/ }))

    expect(
      example.getByText('Chose Tournament → Print entry list⌘P. (Demo: nothing else happens.)'),
    ).toBeVisible()
    expect(example.queryByRole('menu')).toBeNull()
  })

  it('shows this morning’s five finished matches in the carousel', async () => {
    const designSystemPage = await DesignSystemPage.render()
    const example = within(designSystemPage.moreExample('Carousel'))

    expect(example.getByRole('region', { name: 'Finished this morning' })).toBeVisible()
    expect(
      example.getAllByRole('group').map((slide) => [
        slide.getAttribute('aria-label'),
        within(slide).getByRole('article').getAttribute('aria-label'),
        slide.querySelector('.fm-match__scores')!.textContent,
      ]),
    ).toEqual([
      ['1 of 5', 'Nguyen, Thanh vs Silva, Rafael', '11–7, 9–11, 11–8, 11–6'],
      ['2 of 5', 'Lindqvist, Erik vs Haddad, Youssef', '11–5, 11–8, 11–4'],
      ['3 of 5', 'Moreau, Élodie vs Kim, Hyun-woo', '11–9, 7–11, 11–13, 11–8, 12–10'],
      ['4 of 5', 'Patel, Meera vs Dubois, Camille', '11–6, 11–9, 8–11, 11–7'],
      ['5 of 5', 'Haddad, Youssef vs Ali, Rashid', '9–11, 11–7, 11–13, 11–9, 11–8'],
    ])
  })

  it('starts the accordion with the first answer open and the second closed', async () => {
    const user = userEvent.setup()
    const designSystemPage = await DesignSystemPage.render()
    const example = within(designSystemPage.moreExample('Accordion'))
    const [first, second] = example.getAllByRole('group')
    expect(first).toHaveAttribute('open')
    expect(second).not.toHaveAttribute('open')

    await user.click(example.getByText('Scheduling details'))

    expect(second).toHaveAttribute('open')
  })
})
