// Runs before every component test file (vite.config.ts, `test.setupFiles`).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './api/server.ts'

// The router resets scroll on navigation; jsdom has no layout and only logs
// "Not implemented" for scrollTo.
window.scrollTo = () => {}

// Requests no handler answered during the current test. MSW makes each one
// fail with a network error, which the app may well turn into something on
// screen; afterEach then fails the test, so a missing handler is never
// mistaken for "the api could not be reached".
const unhandled: string[] = []

beforeAll(() => {
  server.listen({
    onUnhandledFrame({ frame, defaults }) {
      const data = frame.data as { request?: Request }
      unhandled.push(
        data.request
          ? `${data.request.method} ${data.request.url}`
          : frame.protocol,
      )
      defaults.error()
    },
  })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  const sent = unhandled.splice(0)
  if (sent.length > 0) {
    throw new Error(
      `The test sent requests no MSW handler answered: ${sent.join(', ')}. ` +
        'Add a handler with server.use(...) (src/test/api/).',
    )
  }
})

afterAll(() => {
  server.close()
})
