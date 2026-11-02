import { cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api/client'
import { leavePage } from '../leavePage'
import { clearSiteData, queuedResults, queueSignedResult } from '../test/deviceStorage'
import { HomePage } from '../test/pages/HomePage'
import { API_BASE_URL, mockSigningKeys, server, sessionResponse } from '../test/server'
import { fromHex, toHex, type Bytes } from './bytes'
import { decode, encode, Tagged, type CborMap } from './cbor'
import { signWithDeviceKey } from './deviceKey'
import { encodePayload, registrationParts, toBeSigned } from './signedResults'

vi.mock('../leavePage', () => ({ leavePage: vi.fn() }))

const accountId = sessionResponse.data.account.id
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const

// The key a registration's COSE_Key holds, as the API reads it.
function publicKey(coseKey: string): Promise<CryptoKey> {
  const key = decode(fromHex(coseKey)) as CborMap
  const point = new Uint8Array([4, ...(key.get(-2n) as Bytes), ...(key.get(-3n) as Bytes)])
  return crypto.subtle.importKey('raw', point, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'verify',
  ])
}

async function kid(coseKey: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', fromHex(coseKey))))
}

// Each call is a new page load of Home, on the same browser.
async function loadHome(): Promise<HomePage> {
  cleanup()
  const homePage = await HomePage.render()
  await homePage.findTitle()
  return homePage
}

async function signOutAsGuest(homePage: HomePage): Promise<void> {
  await userEvent.click(homePage.accountButton!)
  await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
  await userEvent.click(within(homePage.guestSignOutDialog).getByRole('button', { name: 'Sign out' }))
  await vi.waitFor(() => expect(leavePage).toHaveBeenCalled())
}

describe('the device signing key', () => {
  afterEach(() => vi.mocked(leavePage).mockReset())

  it('registers a new key to the account once the session starts, with a proof the API accepts', async () => {
    const keys = mockSigningKeys()
    await loadHome()

    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    const [{ public_key, proof, label }] = keys.registrations
    expect(fromHex(public_key)).toHaveLength(75)
    expect(label).toBe('Browser on Linux')

    // The API builds the first 96 bytes itself and compares, then verifies
    // the last 64 over the Sig_structure.
    const parts = registrationParts(fromHex(await kid(public_key)), accountId)
    const unsigned = encode(new Tagged(18, [parts.protected, new Map(), parts.payload, new Uint8Array(64)]))
    const proofBytes = fromHex(proof)
    expect(proofBytes).toHaveLength(160)
    expect(toHex(proofBytes.slice(0, 96))).toBe(toHex(unsigned.slice(0, 96)))
    expect(
      await crypto.subtle.verify(ES256, await publicKey(public_key), proofBytes.slice(96), parts.toBeSigned),
    ).toBe(true)
  })

  it('shows the page without waiting for the registration', async () => {
    let release: (() => void) | undefined
    let answered = false
    server.use(
      http.post(`${API_BASE_URL}/v1/account/signing-keys`, async () => {
        await new Promise<void>((resolve) => (release = resolve))
        answered = true
        return HttpResponse.json({ errors: [{ status: '500', title: 'Failed' }] }, { status: 500 })
      }),
    )
    const homePage = await loadHome()
    expect(homePage.title).toBeVisible()
    await vi.waitFor(() => expect(release).toBeDefined())
    // Answered here, so the next test doesn't get it.
    release!()
    await vi.waitFor(() => expect(answered).toBe(true))
  })

  it('registers the same key on every load', async () => {
    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(2))

    expect(keys.registrations[1].public_key).toBe(keys.registrations[0].public_key)
  })

  it('makes and registers a new key when the stored one is gone', async () => {
    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))

    await clearSiteData()
    await loadHome()

    await vi.waitFor(() => expect(keys.registrations).toHaveLength(2))
    expect(keys.registrations[1].public_key).not.toBe(keys.registrations[0].public_key)
  })

  it.each([
    ['another account owns it', 'ownedElsewhere'],
    ['it was revoked', 'revoked'],
  ] as const)('makes a new key and keeps it when %s', async (_reason, refusal) => {
    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    const old = keys.registrations[0].public_key
    keys[refusal].add(old)

    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(3))
    const replacement = keys.registrations[2].public_key
    expect(keys.registrations[1].public_key).toBe(old)
    expect(replacement).not.toBe(old)

    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(4))
    expect(keys.registrations[3].public_key).toBe(replacement)
  })

  it('shows the page when the registration gets no response, and registers on the next load', async () => {
    const offline = mockSigningKeys({ offline: true })
    const homePage = await loadHome()
    expect(homePage.title).toBeVisible()
    await vi.waitFor(() => expect(offline.registrations).toHaveLength(1))

    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    expect(keys.registrations[0].public_key).toBe(offline.registrations[0].public_key)
  })

  it('signs a result with the registered key', async () => {
    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    const [{ public_key }] = keys.registrations
    const payload = encodePayload({
      issuedAt: 1793534400,
      result: {
        match: '653e2640-99fe-56ba-9f01-14dd69f69a2d',
        bestOf: 3,
        rated: true,
        players: [sessionResponse.data.account.player.id, '6c47577f-0fea-5086-9939-e4f81f2a7b1c'],
        games: [
          [11, 7],
          [11, 9],
        ],
        ending: { kind: 'completed' },
        replaces: null,
      },
    })

    const signature = (await signWithDeviceKey(0, payload))!

    const header = decode(signature.protected) as CborMap
    expect(toHex(header.get(4n) as Bytes)).toBe(await kid(public_key))
    expect(header.get('player')).toBe(0n)
    expect(
      await crypto.subtle.verify(
        ES256,
        await publicKey(public_key),
        signature.signature,
        toBeSigned(signature.protected, payload),
      ),
    ).toBe(true)
  })

  it('signs the key out on sign-out, deletes it and keeps the queue of signed results', async () => {
    const keys = mockSigningKeys()
    const homePage = await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    const signedOut = keys.registrations[0].public_key
    await queueSignedResult('a-result', Uint8Array.of(0xd8, 0x62))

    await signOutAsGuest(homePage)

    expect(keys.logouts).toEqual([{ signing_key_id: await kid(signedOut) }])
    expect((await queuedResults()).map((result) => toHex(result as Bytes))).toEqual(['d862'])
    expect(await signWithDeviceKey(0, Uint8Array.of(0xa0))).toBeNull()

    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(2))
    expect(keys.registrations[1].public_key).not.toBe(signedOut)
  })

  it('signs out the key it holds when a sign-out overtakes a registration that gets a 409', async () => {
    const keys = mockSigningKeys()
    await loadHome()
    await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
    const held = keys.registrations[0].public_key
    let release!: () => void
    let reached = false
    server.use(
      http.post(`${API_BASE_URL}/v1/account/signing-keys`, async () => {
        reached = true
        await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.json(
          { errors: [{ status: '409', title: 'Another account registered this key' }] },
          { status: 409 },
        )
      }),
    )
    const homePage = await loadHome()
    await vi.waitFor(() => expect(reached).toBe(true))

    await userEvent.click(homePage.accountButton!)
    await userEvent.click(within(homePage.accountMenu).getByRole('menuitem', { name: 'Sign out' }))
    await userEvent.click(within(homePage.guestSignOutDialog).getByRole('button', { name: 'Sign out' }))
    release()
    await vi.waitFor(() => expect(leavePage).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(keys.logouts).toEqual([{ signing_key_id: await kid(held) }])
    expect(await signWithDeviceKey(0, Uint8Array.of(0xa0))).toBeNull()
    expect(keys.registrations).toHaveLength(1)
  })

  it("signs out at once while another tab's registration waits for an answer", async () => {
    // The browser's Web Locks, shared by every tab. Each tab is its own copy
    // of the module, with the same IndexedDB.
    const held = new Map<string, Promise<unknown>>()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request(name: string, run: () => Promise<unknown>) {
          const turn = (held.get(name) ?? Promise.resolve()).then(run)
          held.set(name, turn.catch(() => {}))
          return turn
        },
      },
    })
    try {
      const keys = mockSigningKeys()
      const homePage = await loadHome()
      await vi.waitFor(() => expect(keys.registrations).toHaveLength(1))
      const registered = keys.registrations[0].public_key

      let release: (() => void) | undefined
      server.use(
        http.post(`${API_BASE_URL}/v1/account/signing-keys`, async () => {
          await new Promise<void>((resolve) => (release = resolve))
          return HttpResponse.json({ errors: [{ status: '500', title: 'Failed' }] }, { status: 500 })
        }),
      )
      vi.resetModules()
      const otherTab = await import('./deviceKey')
      const otherRegistration = otherTab
        .registerDeviceKey(createApiClient({ baseUrl: API_BASE_URL }), accountId)
        .catch(() => {})
      await vi.waitFor(() => expect(release).toBeDefined())

      await signOutAsGuest(homePage)

      expect(keys.logouts).toEqual([{ signing_key_id: await kid(registered) }])
      expect(await signWithDeviceKey(0, Uint8Array.of(0xa0))).toBeNull()
      release!()
      await otherRegistration
      expect(await signWithDeviceKey(0, Uint8Array.of(0xa0))).toBeNull()
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })
})
