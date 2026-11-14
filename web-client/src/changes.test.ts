import { afterEach, expect, test, vi } from 'vitest'

// The announcement (src/changes.ts) with a stand-in for the BroadcastChannel
// between tabs: what it posts, and a message from another tab arriving. Each
// test loads the module afresh, so it opens its channel on the stand-in. A
// real channel between two tabs is proven in the browser suite
// (e2e/tests/settings.spec.ts, the username from another tab's launch).

class StandInChannel {
  static opened: StandInChannel[] = []
  readonly posted: unknown[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly name: string

  constructor(name: string) {
    this.name = name
    StandInChannel.opened.push(this)
  }

  postMessage(message: unknown) {
    this.posted.push(message)
  }

  // A message another tab posted.
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

async function loadChanges() {
  StandInChannel.opened = []
  vi.resetModules()
  vi.stubGlobal('BroadcastChannel', StandInChannel)
  return import('./changes.ts')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const change = { account: true, matches: [], revision: 0 }

test('an announcement reaches each of this tab’s listeners once, and is posted once on the fortymm-changes channel', async () => {
  const { announce, onChange } = await loadChanges()
  const first = vi.fn()
  const second = vi.fn()
  onChange(first)
  onChange(second)

  announce(change)

  expect(first.mock.calls).toEqual([[change]])
  expect(second.mock.calls).toEqual([[change]])
  expect(StandInChannel.opened.map((channel) => channel.name)).toEqual(['fortymm-changes'])
  expect(StandInChannel.opened[0]!.posted).toEqual([change])
})

test('an announcement from another tab reaches this tab’s listeners, and is not posted again', async () => {
  const { onChange } = await loadChanges()
  const listener = vi.fn()
  onChange(listener)

  StandInChannel.opened[0]!.receive(change)

  expect(listener.mock.calls).toEqual([[change]])
  expect(StandInChannel.opened[0]!.posted).toEqual([])
})

test('a listener that stopped hears nothing more, and one that throws stops no other', async () => {
  const { announce, onChange } = await loadChanges()
  const stopped = vi.fn()
  const after = vi.fn()
  onChange(() => {
    throw new Error('A listener failed')
  })
  onChange(stopped)()
  onChange(after)

  expect(() => announce(change)).not.toThrow()
  expect(stopped).not.toHaveBeenCalled()
  expect(after.mock.calls).toEqual([[change]])
})

test('when the page is shown again, listeners are told everything may have changed', async () => {
  const { onChange } = await loadChanges()
  const listener = vi.fn()
  onChange(listener)

  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))

  expect(listener.mock.calls).toEqual([[{ account: true, matches: 'all', revision: 0 }]])
})

test('when the page comes back from the back/forward cache, listeners are told everything may have changed', async () => {
  const { onChange } = await loadChanges()
  const listener = vi.fn()
  onChange(listener)

  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))

  expect(listener.mock.calls).toEqual([[{ account: true, matches: 'all', revision: 0 }]])
})
