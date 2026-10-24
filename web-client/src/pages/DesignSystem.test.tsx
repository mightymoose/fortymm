import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
import { BUSY_MS } from './designSystem/ButtonsSection'

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
