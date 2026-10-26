import { readFileSync } from 'node:fs'
import { expect, test } from '../fixtures.ts'

// The tenant's domain and client IDs that cloud-run-deploy gave the API.
const auth0 = Object.fromEntries(
  readFileSync(new URL('../../../api/deploy/auth0.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)

// Previews only: a login without a session counts toward the guest account
// limit. It doesn't sign in, so it can't check that Auth0 accepts the callback URL.
test("sends sign-in to the Auth0 tenant's /authorize", async ({ request, baseURL }) => {
  const response = await request.get('/api/v1/auth/login', { maxRedirects: 0 })

  expect(response.status()).toBe(302)
  const location = new URL(response.headers()['location'])
  expect(location.origin).toBe(`https://${auth0.AUTH0_DOMAIN}`)
  expect(location.pathname).toBe('/authorize')
  expect(location.searchParams.get('client_id')).toBe(auth0.AUTH0_PREVIEW_CLIENT_ID)
  expect(location.searchParams.get('redirect_uri')).toBe(
    new URL('/api/v1/auth/callback', baseURL).href,
  )
})
