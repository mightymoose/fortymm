import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test'

// The HTTP rules of the web client's production hosting, the Worker in
// web-client/worker/ (src/index.ts says why each one). No person sees these
// until they go wrong: a stale sw.js leaves phones on an old version, a
// script answered with the app's page breaks it, an api path answered with
// the app's page looks like an answer from the api. Run against the local
// Workers runtime by the e2e task, or a deployment (web-client:hosting-check).
// The proxy to the api has no rule tests of its own here: the hosted health
// page reaching the api (health.spec.ts) is its check, in the stack and on
// each pull request's preview.

// The page every unknown path gets, recognised by the element the app mounts
// in (web-client/index.html).
async function isTheAppPage(response: APIResponse): Promise<boolean> {
  return (await response.text()).includes('<div id="root">')
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
