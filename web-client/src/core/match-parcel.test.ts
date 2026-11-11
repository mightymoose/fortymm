import { expect, test } from 'vitest'
import { loadCore } from './load.ts'
import { createSigner, makeMatchParcel, playerIds } from './match-parcel.ts'

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const draft = {
  environment: 3,
  sides: [[new Uint8Array(32).fill(0x11)], [new Uint8Array(32).fill(0x22)]] as [
    Uint8Array[],
    Uint8Array[],
  ],
  terms: new Uint8Array([1]),
}

test('the signing key is created non-extractable', async () => {
  const signer = await createSigner(await loadCore())

  expect(signer.privateKey.extractable).toBe(false)
  await expect(crypto.subtle.exportKey('pkcs8', signer.privateKey)).rejects.toThrow()
})

test('a made parcel holds one record that verifies against the signer’s key', async () => {
  const core = await loadCore()
  const signer = await createSigner(core)

  const records = core.records(core.parse(await makeMatchParcel(core, signer, draft)))

  expect(records).toHaveLength(1)
  expect(await core.verify(records[0])).toBe(true)
  expect(hex(core.signer(records[0]))).toBe(hex(signer.publicKey))
})

test('two parcels made with the same sides and terms hold two different records', async () => {
  const core = await loadCore()
  const signer = await createSigner(core)

  const [first, second] = await Promise.all(
    [1, 2].map(async () => {
      const [record] = core.records(core.parse(await makeMatchParcel(core, signer, draft)))
      return hex(await core.id(record))
    }),
  )

  expect(first).not.toBe(second)
})

test('player ids are 64 hex digits each, one per line', () => {
  expect(playerIds(`${'ab'.repeat(32)}\n\n${'CD'.repeat(32)}\n`)).toHaveLength(2)
  expect(playerIds('ab'.repeat(31))).toBeNull()
  expect(playerIds('zz'.repeat(32))).toBeNull()
  expect(playerIds('  \n')).toBeNull()
})
