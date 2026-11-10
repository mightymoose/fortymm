// Runs before every component test file (vite.config.ts, `test.setupFiles`).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// The router resets scroll on navigation; jsdom has no layout and only logs
// "Not implemented" for scrollTo.
window.scrollTo = () => {}

afterEach(() => {
  cleanup()
})
