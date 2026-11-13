import moduleUrl from 'fortymm-core/fortymm-core.wasm?url'
import { http, HttpResponse } from 'msw'
import { beforeEach, expect, test, vi } from 'vitest'
import { server } from '../test/api/server.ts'
import type * as Load from './load.ts'

// The real src/core/load.ts, which every other component test replaces
// (src/test/setup.ts). MSW serves the module at the address the page fetches,
// with the real bytes core:wasm built, and counts the requests.

const { readFile } = (await import('node:fs/promises' as string)) as {
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
}
const moduleBytes = await readFile('/opt/core/wasm/fortymm-core.wasm')
const moduleAddress = new URL(moduleUrl, document.baseURI).href

// A fresh load.ts for each test: it keeps its Core for the life of the page.
let loadCore: typeof Load.loadCore
beforeEach(async () => {
  vi.resetModules()
  ;({ loadCore } = await vi.importActual<typeof Load>('./load.ts'))
})

function serveModule(answer: () => Response) {
  const requests: string[] = []
  server.use(
    http.get(moduleAddress, ({ request }) => {
      requests.push(request.url)
      return answer()
    }),
  )
  return requests
}

const theModule = () =>
  new HttpResponse(moduleBytes, { headers: { 'Content-Type': 'application/wasm' } })

test('the module is fetched once per page, and every caller gets the same core', async () => {
  const requests = serveModule(theModule)

  const cores = await Promise.all([loadCore(), loadCore(), loadCore()])
  const later = await loadCore()

  expect(requests).toEqual([moduleAddress])
  expect(new Set([...cores, later]).size).toBe(1)
  expect(later.username(new Uint8Array(32), 4)).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/)
})

test('loading fails when the module’s address answers 404, and the next caller tries again', async () => {
  let found = false
  const requests = serveModule(() =>
    found ? theModule() : new HttpResponse('Not found', { status: 404 }),
  )

  await expect(loadCore()).rejects.toThrow('answered 404')
  found = true
  await expect(loadCore()).resolves.toBeDefined()

  expect(requests).toHaveLength(2)
})
