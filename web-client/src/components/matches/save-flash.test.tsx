import { SAVE_FLASH_DURATION_MS } from './save-flash'
import { saveFlashPage } from './save-flash.page'

describe('SaveFlash', () => {
  it('names the failed game and points at the scoreline as the retry path', () => {
    saveFlashPage.render({ gameNumber: 3 })

    const flash = saveFlashPage.getFlash()
    expect(flash).toHaveTextContent("Game 3 didn't save.")
    expect(flash).toHaveTextContent('Tap it in the scoreline to retry.')
  })

  it('dismisses on the ✕ click', async () => {
    const onDismiss = vi.fn()
    saveFlashPage.render({ onDismiss })

    saveFlashPage.getDismissButton().click()

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('auto-dismisses after 6 seconds without user action', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      saveFlashPage.render({ onDismiss })

      vi.advanceTimersByTime(SAVE_FLASH_DURATION_MS - 1)
      expect(onDismiss).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
