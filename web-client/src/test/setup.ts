import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetMockMatches } from '../mocks/match-store'
import { server } from '../mocks/server'

// testing-library's 1s `findBy*` default is tight on CI: the first test in a
// file pays the MSW + React-Query + jsdom warm-up cost (e.g. waiting for
// `/v1/session` to resolve, then `/v1/players/recent` chips to render) and
// occasionally lands at ~1.05s — flaky-by-design. Bump globally so warm-up
// cost can't time out a fast assertion.
configure({ asyncUtilTimeout: 5000 })

// vitest's jsdom env on Node 26 doesn't expose localStorage. Production code
// guards it with try/catch, but tests want to read/write it directly — give
// them a small in-memory shim.
if (!window.localStorage) {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size
      },
    } satisfies Storage,
  })
}

// jsdom doesn't implement matchMedia; responsive components (e.g. AppShell)
// read it on mount, so provide an inert stub.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

// jsdom doesn't implement ResizeObserver; Radix's popper layer (Tooltip,
// Popover) observes its content's size on mount, so provide an inert stub.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom doesn't implement Element.scrollIntoView; cmdk (the searchable Command
// palette behind the timezone combobox) scrolls the active item into view as
// the list filters, so provide an inert stub.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// Neither jsdom nor Node 26 exposes EventSource, and MSW 2.15's `sse()` response
// resolver INVARIANTS on the global in its constructor
// (`msw/lib/core/sse.js:46`) — so a handler written with it throws at module
// load, before any request is made. Nothing on the happy path needs a real one:
// our realtime reader is `fetch` + `ReadableStream` (see
// `api/realtime/connection.ts`), never `EventSource`. This exists purely so that
// invariant can be satisfied.
if (!('EventSource' in globalThis)) {
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    value: class {
      close() {}
    },
  })
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetMockMatches()
  // The session-bootstrap storage lock (api/session.ts) survives in
  // localStorage across tests within a file. A test that tears down with a
  // `/v1/session` request still in flight strands the lock, and the next
  // tests' session fetches poll it until its 10s TTL lapses — flaky 5s
  // timeouts two tests downstream. No test owns cross-test storage, so wipe
  // it wholesale.
  window.localStorage.clear()
})
afterAll(() => server.close())
