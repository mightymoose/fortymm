import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadPage } from './leavePage'
import { createAppUpdate, UPDATE_CHECK_MS } from './serviceWorker'
import { FakeServiceWorkerContainer } from './test/fakeServiceWorker'

vi.mock('./leavePage')

async function start() {
  const container = new FakeServiceWorkerContainer()
  const appUpdate = createAppUpdate(container)
  await appUpdate.register()
  return { container, appUpdate }
}

function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('createAppUpdate', () => {
  beforeEach(() => vi.mocked(reloadPage).mockReset())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does nothing with no service worker', async () => {
    const appUpdate = createAppUpdate(undefined)
    await appUpdate.register()
    appUpdate.reload()
    expect(appUpdate.getPhase()).toBe('none')
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('checks for a new build when the tab becomes visible', async () => {
    const { container } = await start()
    visibility('visible')
    expect(container.registration.update).toHaveBeenCalledOnce()
  })

  it('does not check while the tab is hidden', async () => {
    const { container } = await start()
    visibility('hidden')
    expect(container.registration.update).not.toHaveBeenCalled()
  })

  it('does not check offline', async () => {
    const { container } = await start()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    visibility('visible')
    expect(container.registration.update).not.toHaveBeenCalled()
  })

  it('checks every hour while the tab is visible', async () => {
    vi.useFakeTimers()
    const { container } = await start()

    vi.advanceTimersByTime(UPDATE_CHECK_MS)
    expect(container.registration.update).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(UPDATE_CHECK_MS)
    expect(container.registration.update).toHaveBeenCalledTimes(2)
  })

  it('drops a check that fails, with nothing logged', async () => {
    const { container, appUpdate } = await start()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    container.registration.update.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    visibility('visible')
    await Promise.resolve()
    await Promise.resolve()

    expect(appUpdate.getPhase()).toBe('none')
    expect(error).not.toHaveBeenCalled()
  })
})
