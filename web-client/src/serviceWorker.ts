import { useSyncExternalStore } from 'react'
import { reloadPage } from './leavePage'

export type UpdatePhase = 'none' | 'ready' | 'dismissed' | 'reloading'

type UpdateEvent = 'worker-waiting' | 'controller-changed' | 'dismiss' | 'reload'

// A controller change shows a dismissed notice again, because from then on
// every route the tab hasn't loaded yet fails (#153).
export function transition(phase: UpdatePhase, event: UpdateEvent): UpdatePhase {
  switch (event) {
    case 'worker-waiting':
      return phase === 'none' ? 'ready' : phase
    case 'controller-changed':
      return phase === 'reloading' ? phase : 'ready'
    case 'dismiss':
      return phase === 'ready' ? 'dismissed' : phase
    case 'reload':
      return phase === 'ready' ? 'reloading' : phase
  }
}

export type AppUpdate = {
  register(): Promise<void>
  subscribe(onChange: () => void): () => void
  getPhase(): UpdatePhase
  reload(): void
  dismiss(): void
}

export type WorkerLike = {
  readonly state: ServiceWorkerState
  postMessage(message: unknown): void
  addEventListener(type: 'statechange', listener: () => void, options?: { once?: boolean }): void
}
export type RegistrationLike = {
  readonly installing: WorkerLike | null
  readonly waiting: WorkerLike | null
  readonly active: WorkerLike | null
  update(): Promise<unknown>
  addEventListener(type: 'updatefound', listener: () => void): void
}
export type ContainerLike = {
  readonly controller: unknown
  register(scriptURL: string): Promise<RegistrationLike>
  addEventListener(type: 'controllerchange', listener: () => void): void
}

// How often a tab that stays open asks whether a new version is out. The
// browser checks /sw.js only on a full page load, and the app navigates
// without one, so a tab left open all day would never hear of a deploy.
export const UPDATE_CHECK_MS = 60 * 60 * 1000

// The message the generated sw.js answers with skipWaiting().
const SKIP_WAITING = { type: 'SKIP_WAITING' } as const

export function createAppUpdate(container: ContainerLike | undefined): AppUpdate {
  let phase: UpdatePhase = 'none'
  let registration: RegistrationLike | null = null
  const listeners = new Set<() => void>()

  const apply = (event: UpdateEvent) => {
    const next = transition(phase, event)
    if (next === phase) return
    phase = next
    for (const listener of listeners) listener()
  }

  // `installed` means the install succeeded, so every file of the new build
  // is in the precache and Reload needs no network.
  const onceInstalled = (worker: WorkerLike | null) => {
    if (!worker) return
    if (worker.state === 'installed') return apply('worker-waiting')
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') apply('worker-waiting')
    })
  }

  const watch = (reg: RegistrationLike) => {
    registration = reg
    // A worker found at registration is newer than this tab's build only in
    // a controlled tab, whose build is the active worker's. An uncontrolled
    // tab (a first visit, a Shift-reload) loaded its build from the network,
    // most likely the very build that waits.
    if (container?.controller) {
      onceInstalled(reg.waiting)
      onceInstalled(reg.installing)
    }
    // A worker that installs while another is active is a newer build, in
    // any tab. The first install ever has no active worker: it is this
    // page's own build.
    reg.addEventListener('updatefound', () => {
      if (reg.active) onceInstalled(reg.installing)
    })

    const check = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      // Offline the check rejects, and there is nothing to show for that.
      reg.update().catch(() => {})
    }
    document.addEventListener('visibilitychange', check)
    setInterval(check, UPDATE_CHECK_MS)
  }

  return {
    async register() {
      if (!container) return
      // Another tab's Reload let a new worker take over, so this tab's
      // precache is gone (#153).
      container.addEventListener('controllerchange', () => apply('controller-changed'))
      // After `load`, so the precache download doesn't compete with the
      // first paint.
      if (document.readyState !== 'complete') {
        await new Promise<void>((resolve) => {
          window.addEventListener('load', () => resolve(), { once: true })
        })
      }
      try {
        watch(await container.register('/sw.js'))
      } catch (error) {
        console.error('Service worker registration failed', error)
      }
    },

    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },

    getPhase: () => phase,

    reload() {
      if (phase !== 'ready') return
      apply('reload')
      const waiting = registration?.waiting
      if (!waiting) {
        reloadPage()
        return
      }
      // A plain reload before the worker takes over serves the old build:
      // the old document is still a client during the navigation. The
      // worker's own statechange, not `controllerchange`, so an uncontrolled
      // tab takes the same path.
      waiting.addEventListener('statechange', reloadPage, { once: true })
      waiting.postMessage(SKIP_WAITING)
    },

    dismiss() {
      apply('dismiss')
    },
  }
}

export function useUpdatePhase(appUpdate: AppUpdate): UpdatePhase {
  return useSyncExternalStore(appUpdate.subscribe, appUpdate.getPhase, appUpdate.getPhase)
}
