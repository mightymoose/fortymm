// Types for fortymm-core.mjs, for TypeScript callers (the web client). Keep
// them in step with the wrapper; check-vectors.mjs fails if a method is
// missing here or extra. Byte values are Uint8Array.

export class Damaged extends Error {}

// Every kind of record the design names (core/FORMAT.md, section 3), as
// `kind` gives it.
export type Kind =
  | 'hello'
  | 'player'
  | 'match'
  | 'score'
  | 'result'
  | 'ruling'
  | 'close-match'
  | 'grant'
  | 'attach-email'
  | 'join'
  | 'same-person'
  | 'name'
  | 'release'
  | 'revoke'
  | 'change-email'
  | 'close-account'
  | 'suspend'
  | 'reinstate'
  | 'clear-name'

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

  // Making a `player`, a `match` and a `score`: each body is signed and
  // assembled as a hello's is. A key, a random value or an id of the wrong
  // length throws. An id is 32 bytes; a side is one or more player ids;
  // `terms` and `value` are bytes the core carries and does not read; `slot`
  // is n for game n (0 is accepted but means no game).
  playerBody(environment: number, publicKey: Uint8Array, random: Uint8Array, clock?: number | null): Uint8Array
  matchBody(environment: number, publicKey: Uint8Array, random: Uint8Array, sides: [Uint8Array[], Uint8Array[]], terms: Uint8Array, clock?: number | null): Uint8Array
  scoreBody(environment: number, publicKey: Uint8Array, random: Uint8Array, matchId: Uint8Array, slot: number, value: Uint8Array, replaces: Uint8Array[], clock?: number | null): Uint8Array

  // The record's kind by name; null for a kind number the design does not
  // name.
  kind(record: Uint8Array): Kind | null

  // What a `score` record says: the match it is about (`matchId` is a
  // `match` record's own id), its slot, its value and the ids of the `score`
  // records it replaces. Null for a record of any other kind.
  scoredMatch(record: Uint8Array): Uint8Array | null
  slot(record: Uint8Array): number | null
  value(record: Uint8Array): Uint8Array | null
  replaces(record: Uint8Array): Uint8Array[] | null

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

  // A match's state, derived from the set of records the device holds about
  // it (core/FORMAT.md, section 16): any order, repeats allowed. Score
  // records of other matches, and records of other kinds, are ignored. Null
  // when the set holds no match record, or a match record of another match
  // too: pass only this match's records. Bytes that are not a record throw.
  matchState(records: Uint8Array[]): MatchState | null
}

export type MatchState = {
  matchId: Uint8Array
  // The key that signed the match record, 33 bytes.
  creator: Uint8Array
  sides: [Uint8Array[], Uint8Array[]]
  // Null for terms of a layout this build can't read.
  terms: { bestOf: number; rated: boolean } | null
  // games[0] is game 1: its final score, first side first, or null for none
  // (not entered, cleared, or a value this build can't read). Never ends
  // with null.
  games: ([number, number] | null)[]
  // Per game, current[0] for game 1, the ids of the score records no score
  // record of that game replaces, lowest first. It can be longer than
  // `games`: a game cleared at the end still has its clearing entry, which
  // the next score for that game must name as replaced.
  current: Uint8Array[][]
}
