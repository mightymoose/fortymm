import { act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
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
