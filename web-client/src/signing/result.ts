import { sha256, uuidBytes, uuidText } from './bytes'
import {
  array,
  bstr,
  decode,
  encode,
  exactKeys,
  Malformed,
  side,
  uint,
  type Cbor,
  type CborMap,
  type Side,
} from './cbor'

export type { Side }

// What a signed result says happened in a match. A retired result always
// names the side that retired, and a completed one can't. The format fixes
// only the shape and types. Whether the scores are a legal ending is the
// server's rule.
export type MatchResult = {
  match: string
  bestOf: 1 | 3 | 5 | 7
  rated: boolean
  // Distinct. Their order fixes the order of each game's points.
  players: [string, string]
  // In the order played, at most bestOf. A retirement can come before a game
  // ends, so the last game may be unfinished.
  games: [number, number][]
  // For a correction, the hash of the result it replaces.
  replaces: Uint8Array<ArrayBuffer> | null
} & ({ ending: 'completed' } | { ending: 'retired'; retiredBy: Side })

// The payload's key for the result. A signature over this payload can't pass
// as one over another CWT that the same key signs. A new version is a new key.
export const DOMAIN_TAG = 'fortymm/match-result/v1'

const IAT = 6
// 9999-12-31T23:59:59Z.
const MAX_IAT = 253402300799
const [MATCH, BEST_OF, RATED, PLAYERS, GAMES, ENDING, RETIRED_BY, REPLACES] = [
  1, 2, 3, 4, 5, 6, 7, 8,
]
const COMPLETED = 0
const RETIRED = 1

// The bytes every signer signs: {6: iat, DOMAIN_TAG: the result}, in
// deterministic CBOR. `issuedAt` is whole seconds since the Unix epoch.
export function encodePayload(issuedAt: number, result: MatchResult): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(issuedAt) || issuedAt < 0 || issuedAt > MAX_IAT) {
    throw new RangeError(`issuedAt ${issuedAt} isn't whole seconds from 1970 to 9999`)
  }
  if (result.players[0] === result.players[1]) throw new RangeError('the players are the same')
  if (result.games.length > result.bestOf) throw new RangeError('more games than bestOf')
  const map: CborMap = new Map<number, Cbor>([
    [MATCH, uuidBytes(result.match)],
    [BEST_OF, result.bestOf],
    [RATED, result.rated],
    [PLAYERS, result.players.map(uuidBytes)],
    [GAMES, result.games],
    [ENDING, result.ending === 'completed' ? COMPLETED : RETIRED],
  ])
  if (result.ending === 'retired') map.set(RETIRED_BY, result.retiredBy)
  if (result.replaces) map.set(REPLACES, result.replaces)
  return encode(new Map<number | string, Cbor>([[IAT, issuedAt], [DOMAIN_TAG, map]]))
}

// The payload's iat and result. Throws Malformed unless the bytes are
// exactly what encodePayload writes for some result.
export function decodePayload(bytes: Uint8Array<ArrayBuffer>): {
  issuedAt: number
  result: MatchResult
} {
  const claims = exactKeys(decode(bytes), [IAT, DOMAIN_TAG])
  const issuedAt = uint(claims.get(IAT))
  if (issuedAt > MAX_IAT) throw new Malformed('iat is after 9999-12-31T23:59:59Z')
  const r = exactKeys(
    claims.get(DOMAIN_TAG),
    [MATCH, BEST_OF, RATED, PLAYERS, GAMES, ENDING],
    [RETIRED_BY, REPLACES],
  )
  const bestOf = format(r.get(BEST_OF))
  const players = array(r.get(PLAYERS), 2).map((player) => uuidText(bstr(player, 16)))
  if (players[0] === players[1]) throw new Malformed('the players are the same')
  const games = array(r.get(GAMES)).map((game): [number, number] => {
    const [first, second] = array(game, 2)
    return [uint(first), uint(second)]
  })
  if (games.length > bestOf) throw new Malformed('more games than best_of')
  const rated = r.get(RATED)
  if (typeof rated !== 'boolean') throw new Malformed('rated isn\'t a boolean')
  const base = {
    match: uuidText(bstr(r.get(MATCH), 16)),
    bestOf,
    rated,
    players: [players[0], players[1]] as [string, string],
    games,
    replaces: r.has(REPLACES) ? bstr(r.get(REPLACES), 32) : null,
  }
  const ending = uint(r.get(ENDING))
  if (ending === COMPLETED && !r.has(RETIRED_BY)) {
    return { issuedAt, result: { ...base, ending: 'completed' } }
  }
  if (ending === RETIRED && r.has(RETIRED_BY)) {
    return { issuedAt, result: { ...base, ending: 'retired', retiredBy: side(r.get(RETIRED_BY)) } }
  }
  throw new Malformed('ending isn\'t 0 without retired_by or 1 with it')
}

function format(value: Cbor | undefined): MatchResult['bestOf'] {
  if (value === 1 || value === 3 || value === 5 || value === 7) return value
  throw new Malformed('best_of isn\'t 1, 3, 5 or 7')
}

// The result's identity: the SHA-256 of the payload bytes.
export function resultHash(payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(payload)
}
