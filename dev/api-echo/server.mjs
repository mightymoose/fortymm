// Test-only stand-in for the api, for the cross-app suite's proxy rules
// (e2e/tests/hosting-proxy.spec.ts): it answers every request with what it
// received, so a test can see what the Worker forwarded, byte for byte. The
// real api can't show that: it has no route that reads a body or a query.
//
// - /status/<code>: that status, with the echo as its body.
// - /redirect: a 302 to the real api (http://api-release:8000/v1/health),
//   which the Worker must hand back, not follow.
// - Anything else: 200 with the echo.
//
// The echo, as JSON: { echo: "api-echo", method, url (the request target as
// received: path and query), headers, body (base64) }.
import { createServer } from 'node:http'

createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const { pathname } = new URL(request.url, 'http://api-echo')
    if (pathname === '/redirect') {
      response.writeHead(302, { Location: 'http://api-release:8000/v1/health' })
      response.end()
      return
    }
    const status = pathname.match(/^\/status\/(\d{3})$/)?.[1]
    const echo = {
      echo: 'api-echo',
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('base64'),
    }
    response.writeHead(status ? Number(status) : 200, {
      'Content-Type': 'application/json',
    })
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(echo))
  })
}).listen(8080, '0.0.0.0')
