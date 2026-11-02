import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadPage } from './leavePage'
import { createAppUpdate, RELOAD_FALLBACK_MS, UPDATE_CHECK_MS } from './serviceWorker'
import { FakeServiceWorkerContainer, type FakeStart } from './test/fakeServiceWorker'

vi.mock('./leavePage')

// Registers against a new fake, as main.tsx does after the page loads.
async function start(options?: FakeStart) {
  const container = new FakeServiceWorkerContainer(options)
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

  it('registers /sw.js once', async () => {
    const { container, appUpdate } = await start()
    expect(container.registered).toEqual(['/sw.js'])
    expect(appUpdate.getPhase()).toBe('none')
  })

  it('does nothing with no service worker', async () => {
    const appUpdate = createAppUpdate(undefined)
    await appUpdate.register()
    appUpdate.reload()
    expect(appUpdate.getPhase()).toBe('none')
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('is ready once a new version has installed, not while it still downloads', async () => {
    const { container, appUpdate } = await start()
    const onChange = vi.fn()
    appUpdate.subscribe(onChange)

    const worker = container.startInstall()
    expect(appUpdate.getPhase()).toBe('none')
    container.finishInstall(worker)

    expect(appUpdate.getPhase()).toBe('ready')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('is ready at once when a version waited as a controlled page loaded', async () => {
    const { appUpdate } = await start({ waiting: true })
    expect(appUpdate.getPhase()).toBe('ready')
  })

  it('ignores a version that waited as an uncontrolled page loaded', async () => {
    const { appUpdate } = await start({ controlled: false, waiting: true })
    expect(appUpdate.getPhase()).toBe('none')
  })

  it('is ready for an install seen after an uncontrolled page registered', async () => {
    const { container, appUpdate } = await start({ controlled: false, active: true })
    container.deploy()
    expect(appUpdate.getPhase()).toBe('ready')
  })

  it('ignores the first install ever', async () => {
    const { container, appUpdate } = await start({ controlled: false })
    container.firstInstall()
    expect(appUpdate.getPhase()).toBe('none')
  })

  it('is ready when the controller changes with no install seen', async () => {
    const { container, appUpdate } = await start()
    container.registration.waiting = container.registration.active
    container.takeOver()
    expect(appUpdate.getPhase()).toBe('ready')
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('on reload, asks the waiting worker to take over and reloads once it has', async () => {
    vi.useFakeTimers()
    const { container, appUpdate } = await start()
    const worker = container.deploy()

    appUpdate.reload()
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(appUpdate.getPhase()).toBe('reloading')
    expect(reloadPage).not.toHaveBeenCalled()

    container.takeOver()
    expect(reloadPage).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS)
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('reloads at once when nothing waits because another tab already reloaded', async () => {
    const { container, appUpdate } = await start()
    const worker = container.deploy()
    container.takeOver()

    appUpdate.reload()
    expect(worker.messages).toEqual([])
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('reloads anyway if the worker never takes over', async () => {
    vi.useFakeTimers()
    const { container, appUpdate } = await start()
    container.deploy()
    appUpdate.reload()

    vi.advanceTimersByTime(RELOAD_FALLBACK_MS - 1)
    expect(reloadPage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('sends one message and reloads once for a second reload', async () => {
    const { container, appUpdate } = await start()
    const worker = container.deploy()

    appUpdate.reload()
    appUpdate.reload()
    container.takeOver()

    expect(worker.messages).toHaveLength(1)
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('stays dismissed through a later deploy, until the controller changes', async () => {
    const { container, appUpdate } = await start()
    container.deploy()
    appUpdate.dismiss()
    expect(appUpdate.getPhase()).toBe('dismissed')

    container.deploy()
    expect(appUpdate.getPhase()).toBe('dismissed')

    container.takeOver()
    expect(appUpdate.getPhase()).toBe('ready')
  })

  it('checks for a new version when the tab becomes visible', async () => {
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
