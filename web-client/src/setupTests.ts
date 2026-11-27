// Vitest setup (see `setupFiles` in vite.config.ts), and the `it` that unit tests import.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, it as base, vi } from 'vitest'
import { server } from './mocks/server.ts'

// Every request goes to MSW; one with no handler fails the test rather than reaching the network.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
// Undo any `server.use(...)` a test added.
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// The core loads its .wasm from disk (see src/core/__mocks__/load-core.ts).
vi.mock('./core/load-core.ts')

// jsdom has no service worker, so no new version is ever waiting.
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: async () => {},
  }),
}))

// Globals are off, so Testing Library can't register its own afterEach cleanup.
afterEach(cleanup)

// jsdom doesn't implement scrolling; the router's scroll restoration calls it on navigation.
window.scrollTo = () => {}

// Vitest's `it`, plus a `user` fixture: a fresh `userEvent.setup()` per test.
export const it = base.extend<{ user: ReturnType<typeof userEvent.setup> }>({
  // Vitest reads fixture dependencies from the destructuring pattern; this one has none.
  // oxlint-disable-next-line no-empty-pattern
  user: async ({}, provide) => {
    await provide(userEvent.setup())
  },
})
