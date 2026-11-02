import { vi } from 'vitest'
import type { ContainerLike, RegistrationLike, WorkerLike } from '../serviceWorker'

export class FakeWorker extends EventTarget implements WorkerLike {
  state: ServiceWorkerState
  readonly messages: unknown[] = []

  constructor(state: ServiceWorkerState) {
    super()
    this.state = state
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  moveTo(state: ServiceWorkerState): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

export class FakeRegistration extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = null
  readonly update = vi.fn(async () => {})
}

export type FakeStart = {
  controlled?: boolean
  active?: boolean
  waiting?: boolean
}

export class FakeServiceWorkerContainer extends EventTarget implements ContainerLike {
  controller: FakeWorker | null = null
  readonly registration = new FakeRegistration()
  readonly registered: string[] = []

  constructor({ controlled = true, active = controlled, waiting = false }: FakeStart = {}) {
    super()
    if (active) this.registration.active = new FakeWorker('activated')
    if (controlled) this.controller = this.registration.active
    if (waiting) this.registration.waiting = new FakeWorker('installed')
  }

  register(scriptURL: string): Promise<RegistrationLike> {
    this.registered.push(scriptURL)
    return Promise.resolve(this.registration)
  }

  deploy(): FakeWorker {
    const worker = this.startInstall()
    this.finishInstall(worker)
    return worker
  }

  startInstall(): FakeWorker {
    const worker = new FakeWorker('installing')
    this.registration.installing = worker
    this.registration.dispatchEvent(new Event('updatefound'))
    return worker
  }

  finishInstall(worker: FakeWorker): void {
    this.registration.installing = null
    this.registration.waiting?.moveTo('redundant')
    this.registration.waiting = worker
    worker.moveTo('installed')
  }

  // No controllerchange, because the sw.js calls no clients.claim().
  firstInstall(): FakeWorker {
    const worker = this.deploy()
    this.registration.waiting = null
    this.registration.active = worker
    worker.moveTo('activating')
    worker.moveTo('activated')
    return worker
  }

  takeOver(): void {
    const worker = this.registration.waiting
    if (!worker) throw new Error('No worker is waiting')
    this.registration.waiting = null
    this.registration.active = worker
    worker.moveTo('activating')
    if (this.controller) {
      this.controller = worker
      this.dispatchEvent(new Event('controllerchange'))
    }
    worker.moveTo('activated')
  }
}
