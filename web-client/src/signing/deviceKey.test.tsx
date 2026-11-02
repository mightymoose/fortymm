import { cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../api/schema'
import { leavePage } from '../leavePage'
import { HomePage } from '../test/pages/HomePage'
import { API_BASE_URL, mockSigningKeys, server, sessionResponse } from '../test/server'
import { fromHex, hex, uuidText } from './bytes'
import { decode, encode, type CborMap, type Tagged } from './cbor'
import { keyId } from './cose'
import { SIGN_OUT_MS, signWithDeviceKey } from './deviceKey'
import { base64url } from './text'

vi.mock('../leavePage', () => ({ leavePage: vi.fn() }))

const account = sessionResponse.data.account

async function storedKid(): Promise<string | null> {
  const signer = await signWithDeviceKey()
  return signer && hex(signer.kid)
}

async function kidOf(publicKey: string): Promise<string> {
  return hex(await keyId(fromHex(publicKey)))
}

// Checks the proof as the API does: its payload names the account, and its
// signature verifies with the registered key.
async function proofVerifies(
  { public_key, proof }: components['schemas']['RegisterKeyRequest'],
  accountId: string,
): Promise<boolean> {
  const { value } = decode(fromHex(proof)) as Tagged
  const [header, , payload, signature] = value as Uint8Array<ArrayBuffer>[]
  const claims = decode(payload) as CborMap
  const registration = claims.get('fortymm/key-registration/v1') as CborMap
  expect(uuidText(registration.get(1) as Uint8Array<ArrayBuffer>)).toBe(accountId)
  const key = decode(fromHex(public_key)) as CborMap
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(key.get(-2) as Uint8Array<ArrayBuffer>),
    y: base64url(key.get(-3) as Uint8Array<ArrayBuffer>),
  }
  const verifier = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifier,
    signature,
    encode(['Signature1', header, new Uint8Array(), payload]),
  )
}

// A page load that waits for the key's registrations to reach `count`.
async function load(registrations: unknown[], count: number): Promise<HomePage> {
  const homePage = await HomePage.render()
  await vi.waitFor(() => expect(registrations).toHaveLength(count))
  return homePage
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('fortymm-signing')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// Another tab's sign-out, as it leaves its record in the shared database.
function otherTabSignsOut(since: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open('fortymm-signing', 1)
    opened.onupgradeneeded = () => opened.result.createObjectStore('device-key')
    opened.onsuccess = () => {
      const transaction = opened.result.transaction('device-key', 'readwrite')
      transaction.objectStore('device-key').put({ count: 1, since }, 'sign-out')
      transaction.oncomplete = () => {
        opened.result.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    opened.onerror = () => reject(opened.error)
  })
}

function signInVerified() {
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: { account: { ...account, kind: 'verified', email: 'ann@example.com' } },
      }),
    ),
  )
}

// Records the body of each logout.
function recordLogouts(): (components['schemas']['LogoutRequest'] | null)[] {
  const bodies: (components['schemas']['LogoutRequest'] | null)[] = []
  server.use(
    http.post(`${API_BASE_URL}/v1/auth/logout`, async ({ request }) => {
      const text = await request.text()
      bodies.push(text ? JSON.parse(text) : null)
      return HttpResponse.json<components['schemas']['LogoutResponse']>({
        data: { logout_url: 'https://fortymm.example/v2/logout' },
      })
    }),
  )
  return bodies
}

async function signOut(homePage: HomePage): Promise<void> {
  await userEvent.click(homePage.accountButton!)
  await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
  await vi.waitFor(() => expect(leavePage).toHaveBeenCalledOnce())
}

describe("the browser's signing key", () => {
  afterEach(() => {
    vi.mocked(leavePage).mockReset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('registers a new key after the session starts, with a proof for the account', async () => {
    const { registrations } = mockSigningKeys()

    await load(registrations, 1)

    const [registration] = registrations
    expect(registration.label).toBe('Web browser')
    expect(await kidOf(registration.public_key)).toBe(await storedKid())
    expect(await proofVerifies(registration, account.id)).toBe(true)
  })

  it('registers the same key again on the next load', async () => {
    const { registrations } = mockSigningKeys()
    await load(registrations, 1)
    cleanup()

    await load(registrations, 2)

    expect(registrations[1].public_key).toBe(registrations[0].public_key)
  })

  it('makes and registers a new key on the next load once the key is gone', async () => {
    const { registrations } = mockSigningKeys()
    await load(registrations, 1)
    cleanup()
    await deleteDatabase()

    await load(registrations, 2)

    expect(registrations[1].public_key).not.toBe(registrations[0].public_key)
    expect(await storedKid()).toBe(await kidOf(registrations[1].public_key))
  })

  it.each([
    ['another account owns it', 'taken'],
    ['it is revoked', 'revoked'],
  ] as const)('replaces the key and registers the new one when %s', async (_, answer) => {
    const { registrations } = mockSigningKeys([answer, answer])

    await load(registrations, 2)

    expect(registrations[1].public_key).not.toBe(registrations[0].public_key)
    expect(await storedKid()).toBe(await kidOf(registrations[1].public_key))
    expect(await proofVerifies(registrations[1], account.id)).toBe(true)
    // A second refusal waits for the next load rather than looping.
    cleanup()
    await load(registrations, 3)
    expect(registrations[2].public_key).toBe(registrations[1].public_key)
  })

  it('keeps the key for the next load when the registration gets no response', async () => {
    server.use(http.post(`${API_BASE_URL}/v1/account/signing-keys`, () => HttpResponse.error()))
    const homePage = await HomePage.render()
    await vi.waitFor(async () => expect(await storedKid()).not.toBeNull())
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    const kid = await storedKid()
    cleanup()

    const { registrations } = mockSigningKeys()
    await load(registrations, 1)

    expect(await kidOf(registrations[0].public_key)).toBe(kid)
  })

  it('signs the key out with the session, then deletes it', async () => {
    signInVerified()
    const { registrations } = mockSigningKeys()
    const logouts = recordLogouts()
    const homePage = await load(registrations, 1)
    const kid = await kidOf(registrations[0].public_key)

    await signOut(homePage)

    expect(logouts).toEqual([{ signing_key_id: kid }])
    expect(await storedKid()).toBeNull()
  })

  it('leaves no key when a sign-out overtakes a registration that needs a new key', async () => {
    signInVerified()
    const keys = mockSigningKeys(['taken'], { hold: true })
    const logouts = recordLogouts()
    const homePage = await load(keys.registrations, 1)

    await signOut(homePage)
    await keys.release()
    // The replacement finds no key to replace. Give it time to write one if
    // it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(logouts).toHaveLength(1)
    expect(await storedKid()).toBeNull()
    expect(keys.registrations).toHaveLength(1)
  })

  it('leaves no key when a registration needs a new key while the logout is in flight', async () => {
    signInVerified()
    const keys = mockSigningKeys(['taken'], { hold: true })
    const logouts: unknown[] = []
    let answerLogout = () => {}
    server.use(
      http.post(`${API_BASE_URL}/v1/auth/logout`, async ({ request }) => {
        logouts.push(await request.json())
        await new Promise<void>((resolve) => (answerLogout = resolve))
        return HttpResponse.json<components['schemas']['LogoutResponse']>({
          data: { logout_url: 'https://fortymm.example/v2/logout' },
        })
      }),
    )
    const homePage = await load(keys.registrations, 1)
    const kid = await kidOf(keys.registrations[0].public_key)

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
    await vi.waitFor(() => expect(logouts).toEqual([{ signing_key_id: kid }]))
    await keys.release()
    // The replacement finds no key to replace. Give it time to write and
    // register one if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50))
    answerLogout()
    await vi.waitFor(() => expect(leavePage).toHaveBeenCalledOnce())

    expect(await storedKid()).toBeNull()
    expect(keys.registrations).toHaveLength(1)
  })

  it('stores no key when a sign-out starts while the first key is being made', async () => {
    signInVerified()
    const keys = mockSigningKeys()
    const logouts = recordLogouts()
    const generateKey = crypto.subtle.generateKey.bind(crypto.subtle)
    let finishKey = () => {}
    const held = new Promise<void>((resolve) => (finishKey = resolve))
    const generating = vi
      .spyOn(crypto.subtle, 'generateKey')
      .mockImplementation(async (...args: Parameters<SubtleCrypto['generateKey']>) => {
        await held
        return generateKey(...args)
      })
    const homePage = await HomePage.render()
    await vi.waitFor(() => expect(generating).toHaveBeenCalled())

    await signOut(homePage)
    finishKey()
    // Give the held key time to be stored and registered if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(logouts).toEqual([null])
    expect(await storedKid()).toBeNull()
    expect(keys.registrations).toHaveLength(0)
  })

  it('stores no key while another tab signs out', async () => {
    const { registrations } = mockSigningKeys()
    await otherTabSignsOut(Date.now())

    const homePage = await HomePage.render()
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')
    // Give a key time to be stored and registered if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await storedKid()).toBeNull()
    expect(registrations).toHaveLength(0)
  })

  it('makes a key when another tab closed during its sign-out long ago', async () => {
    const { registrations } = mockSigningKeys()
    await otherTabSignsOut(Date.now() - SIGN_OUT_MS - 1000)

    await load(registrations, 1)

    expect(await storedKid()).toBe(await kidOf(registrations[0].public_key))
  })

  it('keeps the key when the logout fails, and sends it again on the next sign-out', async () => {
    signInVerified()
    const { registrations } = mockSigningKeys()
    const homePage = await load(registrations, 1)
    const kid = await kidOf(registrations[0].public_key)
    const logouts = recordLogouts()
    server.use(http.post(`${API_BASE_URL}/v1/auth/logout`, () => HttpResponse.error(), { once: true }))

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
    await within(homePage.accountMenu).findByText(/Couldn’t sign you out/)
    expect(await storedKid()).toBe(kid)
    expect(leavePage).not.toHaveBeenCalled()

    // The menu stays open after a failed sign-out.
    await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
    await vi.waitFor(() => expect(leavePage).toHaveBeenCalledOnce())

    expect(logouts).toEqual([{ signing_key_id: kid }])
    expect(await storedKid()).toBeNull()
  })

  it('loads and signs out with no IndexedDB, sending no key', async () => {
    vi.stubGlobal('indexedDB', undefined)
    signInVerified()
    const logouts = recordLogouts()
    const homePage = await HomePage.render()
    expect(homePage.title).toHaveTextContent('What’s coming, and when.')

    await signOut(homePage)

    expect(logouts).toEqual([null])
  })
})
