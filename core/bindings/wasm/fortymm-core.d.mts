// Types for fortymm-core.mjs, for TypeScript callers (the web client). Keep
// them in step with the wrapper. Byte values are Uint8Array.

export class Damaged extends Error {}

export class Core {
  static load(
    wasmBytes: BufferSource,
    options?: { subtle?: SubtleCrypto },
  ): Promise<Core>

  readonly hasCrypto: boolean

  // Records.
  decodeRecord(record: Uint8Array): Uint8Array
  body(record: Uint8Array): Uint8Array
  signature(record: Uint8Array): Uint8Array
  signer(record: Uint8Array): Uint8Array
  id(record: Uint8Array): Promise<Uint8Array>
  verify(record: Uint8Array): Promise<boolean>
  outcomeId(record: Uint8Array): Promise<Uint8Array | null>
  accountId(publicKey: Uint8Array): Promise<Uint8Array>
  ownPlayerId(publicKey: Uint8Array): Promise<Uint8Array>

  // Making a record.
  publicKeyFromRaw(raw: Uint8Array): Uint8Array
  matchBody(
    environment: number,
    signer: Uint8Array,
    random: Uint8Array,
    sides: [Uint8Array[], Uint8Array[]],
    terms: Uint8Array,
  ): Uint8Array
  recordFromParts(body: Uint8Array, signature: Uint8Array): Uint8Array

  // Signatures.
  signatureFromDer(der: Uint8Array): Uint8Array
  signatureFromRaw(raw: Uint8Array): Uint8Array

  // Parcels, as their binary form.
  parse(text: string): Uint8Array
  text(binary: Uint8Array): string
  records(binary: Uint8Array): Uint8Array[]
  build(environment: number, records: Uint8Array[]): Uint8Array
  split(binary: Uint8Array, maxChars: number): Uint8Array[]
}
