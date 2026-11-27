// Vitest setup (see `setupFiles` in vite.config.ts), and the `it` that unit tests import.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, it as base } from 'vitest'

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
