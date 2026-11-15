// Types for fortymm-core.mjs, for TypeScript callers (the web client). Keep
// them in step with the wrapper; check-vectors.mjs fails if a method is
// missing here or extra. Byte values are Uint8Array.

export class Damaged extends Error {}

export class Core {
  static load(wasmBytes: BufferSource): Promise<Core>

  // Records.
  decodeRecord(record: Uint8Array): Uint8Array
  body(record: Uint8Array): Uint8Array
  signature(record: Uint8Array): Uint8Array
  signer(record: Uint8Array): Uint8Array
  id(record: Uint8Array): Uint8Array
  verify(record: Uint8Array): boolean
  outcomeId(record: Uint8Array): Uint8Array | null

  // What a record says about its match and its players: what the bytes say,
  // not that the record counts (`verify` is separate). Null for a record of
  // another kind or one this library did not interpret.
  matchId(record: Uint8Array): Uint8Array | null
  sides(record: Uint8Array): [Uint8Array[], Uint8Array[]] | null
  terms(record: Uint8Array): Uint8Array | null
  repeatsPlayer(record: Uint8Array): boolean | null
  creator(record: Uint8Array): Uint8Array | null
  extraPlayerId(record: Uint8Array): Uint8Array | null
  introducedKey(record: Uint8Array): Uint8Array | null
  signerAccountId(record: Uint8Array): Uint8Array
  signerOwnPlayerId(record: Uint8Array): Uint8Array

  // Making a record: the core builds the body, the platform signs it
  // (WebCrypto's raw r||s, converted with signatureFromRaw), and assemble
  // puts the record together and verifies it (throws if it does not).
  // `random` is 8 bytes from the platform's random generator; `clock` is
  // milliseconds since the Unix epoch, or null.
  helloBody(environment: number, publicKey: Uint8Array, random: Uint8Array, clock?: number | null): Uint8Array
  assemble(body: Uint8Array, signature: Uint8Array): Uint8Array

  // Keys: the 33 bytes a record stores.
  accountId(publicKey: Uint8Array): Uint8Array
  ownPlayerId(publicKey: Uint8Array): Uint8Array

  // The generated username of a 32-byte player id; the suffix is 4 to 16
  // characters.
  username(playerId: Uint8Array, suffixLength: number): string

  // Signatures.
  signatureFromDer(der: Uint8Array): Uint8Array
  signatureFromRaw(raw: Uint8Array): Uint8Array

  // Parcels, as their binary form.
  parse(text: string): Uint8Array
  text(binary: Uint8Array): string
  records(binary: Uint8Array): Uint8Array[]
  build(environment: number, records: Uint8Array[]): Uint8Array
  split(binary: Uint8Array, maxChars: number): Uint8Array[]

  // The product layouts: the bytes a `match` record carries as its terms and
  // a `score` record as its value. `bestOf` is an odd number, 1 or more;
  // termsBytes throws for any other. A score is the two sides' points, first
  // side first, or null for a cleared game. Reading gives null for bytes of
  // another layout version and for damaged bytes.
  termsBytes(bestOf: number, rated: boolean): Uint8Array
  readTerms(terms: Uint8Array): { bestOf: number; rated: boolean } | null
  scoreValue(score: [number, number] | null): Uint8Array
  readScoreValue(value: Uint8Array): { score: [number, number] | null } | null
}
