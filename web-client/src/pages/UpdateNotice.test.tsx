import { act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadPage } from '../leavePage'
import { createAppUpdate } from '../serviceWorker'
import {
  FakeServiceWorkerContainer,
  type FakeStart,
  type FakeWorker,
} from '../test/fakeServiceWorker'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'
import { HomePage } from '../test/pages/HomePage'
import { UpdateNotice } from '../test/pages/UpdateNotice'

vi.mock('../leavePage')

async function renderWithWorker(options?: FakeStart) {
  const container = new FakeServiceWorkerContainer(options)
  const appUpdate = createAppUpdate(container)
  await HomePage.render({ appUpdate })
  await act(() => appUpdate.register())
  return { container, notice: new UpdateNotice() }
}

function deploy(container: FakeServiceWorkerContainer): FakeWorker {
  let worker!: FakeWorker
  act(() => {
    worker = container.deploy()
  })
  return worker
}

describe('UpdateNotice', () => {
  beforeEach(() => vi.mocked(reloadPage).mockReset())

  it('shows nothing while no new build is downloaded', async () => {
    const { container, notice } = await renderWithWorker()
    expect(container.registered).toEqual(['/sw.js'])
    expect(notice.message).toBeNull()
  })

  it('offers Reload once a new build has installed, not while it still downloads', async () => {
    const { container, notice } = await renderWithWorker()

    const worker = container.startInstall()
    expect(notice.message).toBeNull()
    act(() => container.finishInstall(worker))

    expect(notice.message).toBeVisible()
    expect(notice.reloadButton).toHaveTextContent('Reload')
  })

  it('offers Reload when a new build already waited as the page loaded', async () => {
    const { notice } = await renderWithWorker({ waiting: true })
    expect(notice.message).toBeVisible()
  })

  it('shows nothing for a build that waited as an uncontrolled page loaded', async () => {
    const { notice } = await renderWithWorker({ controlled: false, waiting: true })
    expect(notice.message).toBeNull()
  })

  it('shows the notice for an install seen after an uncontrolled page registered', async () => {
    const { container, notice } = await renderWithWorker({ controlled: false, active: true })
    deploy(container)
    expect(notice.message).toBeVisible()
  })

  it('shows nothing for the first install ever', async () => {
    const { container, notice } = await renderWithWorker({ controlled: false })
    act(() => void container.firstInstall())
    expect(notice.message).toBeNull()
  })

  it('on Reload, asks the waiting worker to take over and reloads only once it has', async () => {
    const { container, notice } = await renderWithWorker()
    const worker = deploy(container)
    await userEvent.click(notice.reloadButton)
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(reloadPage).not.toHaveBeenCalled()
    expect(notice.reloadButton).toHaveTextContent('Reloading…')
    expect(notice.dismissButton).toBeNull()

    act(() => container.takeOver())
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('on Reload, reloads at once when nothing waits because another tab already reloaded', async () => {
    const { container, notice } = await renderWithWorker()
    const worker = deploy(container)
    act(() => container.takeOver())
    expect(notice.message).toBeVisible()

    await userEvent.click(notice.reloadButton)

    expect(worker.messages).toEqual([])
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('shows the notice when the controller changes with no install seen', async () => {
    const { container, notice } = await renderWithWorker()
    container.registration.waiting = container.registration.active
    act(() => container.takeOver())

    expect(notice.message).toBeVisible()
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('sends one message and reloads once for a double click on Reload', async () => {
    const { container, notice } = await renderWithWorker()
    const worker = deploy(container)

    const button = notice.reloadButton
    fireEvent.click(button)
    fireEvent.click(button)
    act(() => container.takeOver())

    expect(worker.messages).toHaveLength(1)
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('Dismiss hides the notice through a later deploy, until another tab reloads', async () => {
    const { container, notice } = await renderWithWorker()
    deploy(container)
    await userEvent.click(notice.dismissButton!)
    expect(notice.message).toBeNull()

    deploy(container)
    expect(notice.message).toBeNull()

    act(() => container.takeOver())
    expect(notice.message).toBeVisible()
  })

  it('shows the notice on a public page with no AppShell', async () => {
    const container = new FakeServiceWorkerContainer({ waiting: true })
    const appUpdate = createAppUpdate(container)
    const designSystemPage = await DesignSystemPage.render({ appUpdate })
    await act(() => appUpdate.register())

    expect(designSystemPage.sidebar).not.toBeInTheDocument()
    expect(new UpdateNotice().message).toBeVisible()
  })
})
