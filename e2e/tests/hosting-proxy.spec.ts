import { connect } from 'node:net'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { echoOf, isTheAppPage } from '../pages/answers.ts'

// The Worker's proxy to the api, byte for byte (project worker-proxy: the
// local Workers runtime given api-echo, a stand-in for the api that answers
// with what it received, dev/api-echo/server.mjs). The real api has no route
// that would show a body or a query arriving; hosting-api.spec.ts proves its
// own answers come back through the Worker.

// Where the Worker was told the api is (compose.dev.yaml).
const apiHost = 'api-echo:8080'
// Another host on the suite's network that answers, so a request sent there
// would come back with something other than the echo.
const otherHost = 'api-release:8000'

// Every byte value, so nothing is re-encoded on the way.
const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

async function hashedScript(request: APIRequestContext): Promise<string> {
  const page = await (await request.get('/')).text()
  const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  if (!script) throw new Error(`The app's page loads no /assets/ script:\n${page}`)
  return script
}

test.describe('what is forwarded', () => {
  test('a GET goes to the api with /api stripped and the query string unchanged', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/v1/things?a=1&b=two%20words&a=3&empty=&c=%2F%3F',
    )

    const echo = await echoOf(response)
    expect(echo?.method).toBe('GET')
    expect(echo?.url).toBe('/v1/things?a=1&b=two%20words&a=3&empty=&c=%2F%3F')
    expect(echo?.headers.host).toBe(apiHost)
  })

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`a ${method} arrives with its method, body, headers and query unchanged`, async ({
      request,
    }) => {
      const response = await request.fetch('/api/v1/things/7?dry=1', {
        method,
        data: everyByte,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Request-Id': 'abc-123',
          Cookie: 'session=s3cret',
        },
      })

      const echo = await echoOf(response)
      expect(echo?.method).toBe(method)
      expect(echo?.url).toBe('/v1/things/7?dry=1')
      expect(echo?.body.equals(everyByte)).toBe(true)
      expect(echo?.headers['content-type']).toBe('application/octet-stream')
      expect(echo?.headers['x-request-id']).toBe('abc-123')
      expect(echo?.headers.cookie).toBe('session=s3cret')
    })
  }

  for (const status of [201, 418, 503]) {
    test(`the api’s status ${status} and its body come back unchanged`, async ({
      request,
    }) => {
      const response = await request.post(`/api/status/${status}`, {
        data: 'x',
      })

      expect(response.status()).toBe(status)
      expect(response.headers()['content-type']).toMatch(/^application\/json\b/)
      expect((await echoOf(response))?.url).toBe(`/status/${status}`)
    })
  }

  // Handed back, not followed: following it would have the Worker call the
  // host the api named.
  test('the api’s redirect comes back as it is, not followed', async ({
    request,
  }) => {
    const response = await request.get('/api/redirect', { maxRedirects: 0 })

    expect(response.status()).toBe(302)
    expect(response.headers().location).toBe(`http://${otherHost}/v1/health`)
  })
})

test.describe('/api/* is the api’s, never the build’s', () => {
  test('/api and /api/ go to the api’s /', async ({ request }) => {
    expect((await echoOf(await request.get('/api')))?.url).toBe('/')
    expect((await echoOf(await request.get('/api/')))?.url).toBe('/')
  })

  test('a path under /api/ that names a file of the build goes to the api, not the file', async ({
    request,
  }) => {
    const paths = [
      '/index.html',
      '/sw.js',
      '/manifest.webmanifest',
      await hashedScript(request),
    ]
    for (const path of paths) {
      const response = await request.get(`/api${path}`)
      expect(await isTheAppPage(response), path).toBe(false)
      expect((await echoOf(response))?.url, path).toBe(path)
    }
  })

  test('no other path is forwarded: they get the app’s page', async ({
    request,
  }) => {
    const paths = [
      '/v1/health',
      '/apix/v1/health',
      '/API/v1/health',
      '/%61pi/v1/health',
      '/no/api/v1/health',
      `/api@${otherHost}/v1/health`,
    ]
    for (const path of paths) {
      const response = await request.get(path)
      expect(await echoOf(response), path).toBeNull()
      expect(await isTheAppPage(response), path).toBe(true)
    }
  })

  test('a POST to another path is not forwarded', async ({ request }) => {
    const response = await request.post('/v1/health', { data: 'x' })

    expect(response.status()).toBe(404)
    expect(await echoOf(response)).toBeNull()
  })
})

test.describe('only ever the configured api', () => {
  // Paths that would name another host if the Worker joined strings or
  // resolved the path against the api's address.
  for (const path of [
    `//${otherHost}/v1/health`,
    `/http://${otherHost}/v1/health`,
    `/https:/${otherHost}/v1/health`,
    `/@${otherHost}/v1/health`,
  ]) {
    test(`/api${path} goes to the configured api, as a path`, async ({
      request,
    }) => {
      const response = await request.get(`/api${path}`)

      const echo = await echoOf(response)
      expect(echo?.headers.host).toBe(apiHost)
      expect(echo?.url).toContain(`${otherHost}/v1/health`)
    })
  }

  test('headers that name another host change nothing', async ({ request }) => {
    const response = await request.get('/api/v1/health', {
      headers: {
        Host: otherHost,
        'X-Forwarded-Host': otherHost,
        Forwarded: `host=${otherHost}`,
        'X-Original-URL': `http://${otherHost}/v1/health`,
        'X-Rewrite-URL': `http://${otherHost}/v1/health`,
      },
    })

    const echo = await echoOf(response)
    expect(echo?.url).toBe('/v1/health')
    expect(echo?.headers.host).toBe(apiHost)
  })

  // An absolute URL as the request target (GET http://host/path HTTP/1.1),
  // which a browser never sends but anyone can: written by hand on a socket.
  test('an absolute URL as the request target changes nothing', async ({
    baseURL,
  }) => {
    const { hostname, port } = new URL(baseURL!)
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port || 80), hostname, () => {
        socket.end(
          `GET http://${otherHost}/api/v1/health HTTP/1.1\r\n` +
            `Host: ${otherHost}\r\nConnection: close\r\n\r\n`,
        )
      })
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })

    // The other host's /v1/health would say "database"; the configured api
    // gets the path and nothing of the target's host.
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
    expect(body).not.toContain('"database"')
    expect(body).toContain('"url":"/v1/health"')
    expect(body).toContain(`"host":"${apiHost}"`)
  })
})
