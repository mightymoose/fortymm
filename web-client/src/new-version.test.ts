import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  checkEvery,
  takeOverMessage,
  watchForNewVersion,
  type Container,
  type KeptWorker,
  type Registration,
} from './new-version.ts'

// Stand-ins for the browser's service worker objects, moved through the
// states the browser moves the real ones through.
class FakeWorker extends EventTarget implements KeptWorker {
  state: ServiceWorkerState
  readonly messages: unknown[] = []

  constructor(state: ServiceWorkerState) {
    super()
    this.state = state
  }

  postMessage(message: unknown) {
    this.messages.push(message)
  }

  become(state: ServiceWorkerState) {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget implements Registration {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  checks = 0
  // The next look fails, as it does with no connection.
  failNextCheck = false

  // Not a vi.fn(): Vitest's mock handles the promises it returns, which
  // would hide a rejection the app leaves unhandled.
  update() {
    this.checks += 1
    if (this.failNextCheck) {
      this.failNextCheck = false
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return Promise.resolve()
  }
}

class FakeContainer extends EventTarget implements Container {
  controller: FakeWorker | null

  constructor(controller: FakeWorker | null) {
    super()
    this.controller = controller
  }
}

// A page of the app open on the current build (controlled by its worker),
// or on a first visit (controlled by none).
function openPage(options?: {
  firstVisit?: boolean
  waiting?: boolean
  installing?: boolean
}) {
  const registration = new FakeRegistration()
  const container = new FakeContainer(
    options?.firstVisit ? null : new FakeWorker('activated'),
  )
  if (options?.waiting) registration.waiting = new FakeWorker('installed')
  if (options?.installing) registration.installing = new FakeWorker('installing')
  const reloadPage = vi.fn()
  const newVersion = watchForNewVersion(registration, container, reloadPage)
  stops.push(() => newVersion.stop())
  return { registration, container, reloadPage, newVersion }
}

// The browser found a new sw.js: its worker starts installing.
function newDeploymentFound(registration: FakeRegistration) {
  const worker = new FakeWorker('installing')
  registration.installing = worker
  registration.dispatchEvent(new Event('updatefound'))
  return worker
}

// It kept every file of its build, and waits.
function installed(registration: FakeRegistration, worker: FakeWorker) {
  registration.installing = null
  registration.waiting = worker
  worker.become('installed')
}

// A file failed to download: the install fails.
function failed(registration: FakeRegistration, worker: FakeWorker) {
  registration.installing = null
  worker.become('redundant')
}

// The waiting (or, on a first visit, the installing) worker takes over:
// it controls the page now.
function takesOver(
  registration: FakeRegistration,
  container: FakeContainer,
  worker: FakeWorker,
) {
  registration.waiting = null
  worker.become('activating')
  container.controller = worker
  container.dispatchEvent(new Event('controllerchange'))
}

const stops: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
})

test('a page on the newest build shows nothing', () => {
  const { newVersion } = openPage()

  expect(newVersion.ready()).toBe(false)
})

test('while a new deployment downloads, nothing shows', () => {
  const { registration, newVersion } = openPage()

  newDeploymentFound(registration)

  expect(newVersion.ready()).toBe(false)
})

test('a page that loads while a new deployment is still downloading shows it once it is installed', () => {
  const { registration, newVersion } = openPage({ installing: true })
  expect(newVersion.ready()).toBe(false)

  installed(registration, registration.installing!)

  expect(newVersion.ready()).toBe(true)
})

test('once a new deployment is installed and waiting, a new version is ready, and listeners hear of it', () => {
  const { registration, newVersion } = openPage()
  const listener = vi.fn()
  newVersion.subscribe(listener)
  const worker = newDeploymentFound(registration)

  installed(registration, worker)

  expect(newVersion.ready()).toBe(true)
  expect(listener).toHaveBeenCalledOnce()
})

test('a page that loads with a new deployment already waiting shows it at once', () => {
  const { newVersion } = openPage({ waiting: true })

  expect(newVersion.ready()).toBe(true)
})

test('on a first visit, the first worker installing and taking over is no new version, and the page is not reloaded', () => {
  const { registration, container, reloadPage, newVersion } = openPage({
    firstVisit: true,
  })

  const worker = newDeploymentFound(registration)
  installed(registration, worker)
  takesOver(registration, container, worker)

  expect(newVersion.ready()).toBe(false)
  expect(reloadPage).not.toHaveBeenCalled()
})

test('a download that fails shows nothing', () => {
  const { registration, newVersion } = openPage()

  failed(registration, newDeploymentFound(registration))

  expect(newVersion.ready()).toBe(false)
})

test('dismissed, the notice hides, and comes back when yet another deployment is installed', () => {
  const { registration, newVersion } = openPage({ waiting: true })

  newVersion.dismiss()
  expect(newVersion.ready()).toBe(false)

  installed(registration, newDeploymentFound(registration))
  expect(newVersion.ready()).toBe(true)
})

test('a new version waits, dismissed or not, and nothing waits on the newest build', () => {
  expect(openPage().newVersion.waiting()).toBe(false)
  const { newVersion } = openPage({ waiting: true })
  expect(newVersion.waiting()).toBe(true)

  newVersion.dismiss()

  expect(newVersion.waiting()).toBe(true)
})

test('nothing reloads the page by itself: a new version installed and waiting leaves it as it is', () => {
  const { registration, reloadPage } = openPage()

  installed(registration, newDeploymentFound(registration))
  vi.advanceTimersByTime(checkEvery * 2)

  expect(reloadPage).not.toHaveBeenCalled()
  expect(registration.waiting?.messages).toEqual([])
})

test('Reload asks the waiting worker to take over, and reloads the page once it does, exactly once', () => {
  const { registration, container, reloadPage, newVersion } = openPage({
    waiting: true,
  })
  const waiting = registration.waiting!

  newVersion.reload()
  expect(waiting.messages).toEqual([takeOverMessage])
  expect(reloadPage).not.toHaveBeenCalled()

  takesOver(registration, container, waiting)
  container.dispatchEvent(new Event('controllerchange'))

  expect(reloadPage).toHaveBeenCalledOnce()
})

test('when another tab’s Reload makes the new version take over, this page shows it again, even dismissed, and is not reloaded until asked', () => {
  const { registration, container, reloadPage, newVersion } = openPage({
    waiting: true,
  })
  newVersion.dismiss()

  takesOver(registration, container, registration.waiting!)
  expect(newVersion.ready()).toBe(true)
  expect(reloadPage).not.toHaveBeenCalled()

  newVersion.reload()
  expect(reloadPage).toHaveBeenCalledOnce()
})

test('an open page asks the browser to look for a new deployment every 15 minutes', () => {
  const { registration } = openPage()

  vi.advanceTimersByTime(checkEvery - 1)
  expect(registration.checks).toBe(0)
  vi.advanceTimersByTime(1)
  expect(registration.checks).toBe(1)
  vi.advanceTimersByTime(checkEvery)
  expect(registration.checks).toBe(2)
})

test('an open page looks for a new deployment when it comes back into view, and when the connection comes back', () => {
  const { registration } = openPage()

  document.dispatchEvent(new Event('visibilitychange'))
  expect(registration.checks).toBe(1)

  window.dispatchEvent(new Event('online'))
  expect(registration.checks).toBe(2)
})

// A rejection nobody handles fails the run (Vitest reports it), once a real
// task has passed: hence real timers here.
test('a look that fails (no connection) is no error', async () => {
  vi.useRealTimers()
  const { registration, newVersion } = openPage()
  registration.failNextCheck = true

  window.dispatchEvent(new Event('online'))
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(registration.checks).toBe(1)
  expect(newVersion.ready()).toBe(false)
})
