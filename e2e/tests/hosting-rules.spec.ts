import { expect, test, type APIRequestContext } from '@playwright/test'
import { isTheAppPage, methods } from '../pages/app-page.ts'

// The HTTP rules of the web client's production hosting, the Worker in
// web-client/worker/ (src/index.ts says why each one), with the api behind
// its proxy. No person sees these until they go wrong: a stale sw.js leaves
// phones on an old version, a script answered with the app's page breaks it,
// an api path answered with the app's page looks like an answer from the api.
// Run against the local Workers runtime, proxying to api-release, by the e2e
// task; or a pull request's preview, proxying to its api
// (web-client:hosting-check).

// What the api answers at /v1/health when it reaches its database
// (api/openapi.json, HealthDocument).
const apiHealthy = {
  data: { type: 'health', id: 'api', attributes: { database: 'ok' } },
}

// A file of the build whose name carries a hash of its content: the script
// the app's page loads.
async function hashedScript(
  request: APIRequestContext,
): Promise<string> {
  const page = await (await request.get('/')).text()
  const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  if (!script) throw new Error(`The app's page loads no /assets/ script:\n${page}`)
  return script
}

test('the service worker is served at /sw.js as JavaScript, uncached', async ({
  request,
}) => {
  const response = await request.get('/sw.js')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(
    /^(text|application)\/javascript\b/,
  )
  expect(response.headers()['cache-control']).toBe('no-cache')
  expect(await isTheAppPage(response)).toBe(false)
})

test('the manifest is served as application/manifest+json, uncached', async ({
  request,
}) => {
  const response = await request.get('/manifest.webmanifest')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(
    /^application\/manifest\+json\b/,
  )
  expect(response.headers()['cache-control']).toBe('no-cache')
})

for (const path of ['/', '/index.html', '/no/such/page']) {
  test(`the app's page at ${path} is uncached, so a deployment is seen at once`, async ({
    request,
  }) => {
    const response = await request.get(path)

    expect(response.status()).toBe(200)
    expect(await isTheAppPage(response)).toBe(true)
    expect(response.headers()['cache-control']).toBe('no-cache')
  })
}

test('a hashed file under /assets/ is cached for a year, immutable', async ({
  request,
}) => {
  const response = await request.get(await hashedScript(request))

  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toBe(
    'public, max-age=31536000, immutable',
  )
})

test('a missing file under /assets/ is a 404, not the app’s page', async ({
  request,
}) => {
  const response = await request.get('/assets/no-such-file.js')

  expect(response.status()).toBe(404)
  expect(await isTheAppPage(response)).toBe(false)
})

test('GET /api/v1/health is the api’s answer to /v1/health', async ({
  request,
}) => {
  const response = await request.get('/api/v1/health')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/)
  expect(await response.json()).toEqual(apiHealthy)
})

// Every answer of the api is JSON, its errors included (FastAPI's own 404 and
// 405 too), so a JSON answer here is the api's, and the app's page never is.
for (const method of methods) {
  test(`${method} to /api and /api/* is the api’s answer, never the app’s page`, async ({
    request,
  }) => {
    const wrong = []
    for (const path of ['/api', '/api/', '/api/v1/health', '/api/no/such/path']) {
      const response = await request.fetch(path, { method, maxRedirects: 0 })
      const type = response.headers()['content-type'] ?? ''
      if ((await isTheAppPage(response)) || !type.startsWith('application/json')) {
        wrong.push(`${path}: ${response.status()} ${type}`)
      }
    }

    expect(wrong).toEqual([])
  })
}

// The method reaches the api as sent: /v1/health takes only GET, so a POST
// gets the api's 405.
test('a POST to /api/v1/health reaches the api as a POST', async ({
  request,
}) => {
  const response = await request.post('/api/v1/health', { data: 'x' })

  expect(response.status()).toBe(405)
  expect((await response.json()).errors[0].code).toBe('method_not_allowed')
})

// /api/ is stripped by joining the rest of the path to the api's origin, so a
// path that would read as another address on its own still goes to the api.
test('a path under /api/ that looks like another address still goes to the api', async ({
  request,
}) => {
  const response = await request.get('/api//example.com/v1/health')

  expect(response.status()).toBe(404)
  expect((await response.json()).errors[0].code).toBe('not_found')
})

// The api redirects to its own address (FastAPI's /v1/health/ to
// /v1/health); the browser must stay on the app's origin, under /api.
test('a redirect from the api stays on the app’s origin, under /api', async ({
  request,
}) => {
  const response = await request.get('/api/v1/health/', { maxRedirects: 0 })

  expect(response.status()).toBe(307)
  expect(response.headers()['location']).toBe('/api/v1/health')
})

// The browser must always ask the api, and the api's own headers never
// weaken the hosting's.
test('the api’s answers are never cached, and carry nosniff', async ({
  request,
}) => {
  const response = await request.get('/api/v1/health')

  expect(await response.json()).toEqual(apiHealthy)
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
})

// Only /api and what is under /api/ are the api's.
test('a path that only starts like /api gets the app’s page', async ({
  request,
}) => {
  const response = await request.get('/apiary')

  expect(response.status()).toBe(200)
  expect(await isTheAppPage(response)).toBe(true)
})

// The app's page is for page loads only. A form or a script posting to a
// path the build doesn't have gets a 404, not the page and not an error.
test('a POST to a path that is not a file is a 404, not the app’s page', async ({
  request,
}) => {
  const response = await request.post('/no/such/page', { data: 'x' })

  expect(response.status()).toBe(404)
  expect(await isTheAppPage(response)).toBe(false)
})

test('every response carries X-Content-Type-Options: nosniff', async ({
  request,
}) => {
  const paths = [
    '/',
    '/index.html',
    '/no/such/page',
    '/sw.js',
    '/manifest.webmanifest',
    '/favicon.svg',
    await hashedScript(request),
    '/assets/no-such-file.js',
    '/api/v1/health',
  ]

  const missing = []
  for (const path of paths) {
    const response = await request.get(path)
    if (response.headers()['x-content-type-options'] !== 'nosniff') {
      missing.push(`${path} (${response.status()})`)
    }
  }

  expect(missing).toEqual([])
})
