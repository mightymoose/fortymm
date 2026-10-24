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
    ).toEqual(['Buttons', 'Fields, dates and choices', 'Feedback', 'Overlays'])
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
