import { z } from 'zod'
import { decode, Malformed, type Side } from '../signing/cbor'
import { decodeEnvelope } from '../signing/envelope'
import { decodePayload, encodePayload, resultHash, type MatchResult } from '../signing/result'
import { base64url, fromBase64url } from '../signing/text'
import { checkGame, type GamePoints } from './board'
import type { Match } from './demoMatches'

// What a result must share with the match it's for.
type MatchRules = Pick<Match, 'uuid' | 'bestOf' | 'rated'>

// A match's scores live in the URL's fragment, so any scoring URL can be
// shared and nothing else holds them. The fragment is empty, a bare payload
// (a draft nobody approved yet), or a COSE_Sign envelope with its
// signatures, the same bytes a result link carries.
export type Fragment =
  | { kind: 'empty' }
  | { kind: 'draft'; result: MatchResult }
  | {
      kind: 'signed'
      envelope: Uint8Array<ArrayBuffer>
      payload: Uint8Array<ArrayBuffer>
      issuedAt: number
      result: MatchResult
      // The side each signature approved for, in signing order.
      signers: Side[]
    }

const COSE_SIGN = 98

// What the scoring pages can open for `match`: a completed result of legal
// games, no more than the match's best of. The players are matchFor()'s
// rule, because only this device knows who it stands in for.
export function fragmentResultSchema(match: MatchRules) {
  const legalGame = z
    .tuple([z.int(), z.int()])
    .refine((points) => checkGame(points).kind === 'legal', 'a game isn’t a legal final score')
  return z.object({
    match: z.literal(match.uuid),
    bestOf: z.literal(match.bestOf),
    rated: z.literal(match.rated),
    players: z.tuple([z.string(), z.string()]),
    games: z.array(legalGame).max(match.bestOf),
    ending: z.literal('completed'),
    replaces: z.custom<Uint8Array<ArrayBuffer>>((value) => ArrayBuffer.isView(value)).nullable(),
  })
}

// The fragment's scores for `match`, or null when they can't be read or
// don't fit the match. The scoring routes' loaders call it, so each page
// gets a fragment it can trust.
export function readFragment(hash: string, match: MatchRules): Fragment | null {
  let fragment: Fragment
  try {
    fragment = decodeFragment(hash)
  } catch (error) {
    if (error instanceof Malformed) return null
    throw error
  }
  if (fragment.kind === 'empty') return fragment
  return fragmentResultSchema(match).safeParse(fragment.result).success ? fragment : null
}

function decodeFragment(hash: string): Fragment {
  if (hash === '') return { kind: 'empty' }
  const bytes = fromBase64url(hash)
  const item = decode(bytes)
  if (typeof item === 'object' && 'tag' in item && item.tag === COSE_SIGN) {
    const { payload, signatures } = decodeEnvelope(bytes)
    return {
      kind: 'signed',
      envelope: bytes,
      payload,
      ...decodePayload(payload),
      signers: signatures.map(({ side }) => side),
    }
  }
  return { kind: 'draft', result: decodePayload(bytes).result }
}

export function gamesOf(fragment: Fragment): GamePoints[] {
  return fragment.kind === 'empty' ? [] : fragment.result.games
}

// The result a change to `fragment` corrects: the signed result itself, or
// the one its draft already names. Hashing is async, so a handler awaits it.
export async function replacesOf(fragment: Fragment): Promise<Uint8Array<ArrayBuffer> | null> {
  switch (fragment.kind) {
    case 'empty':
      return null
    case 'draft':
      return fragment.result.replaces
    case 'signed':
      return resultHash(fragment.payload)
  }
}

export function resultOf(match: Match, games: GamePoints[], replaces: Uint8Array<ArrayBuffer> | null): MatchResult {
  return {
    match: match.uuid,
    bestOf: match.bestOf,
    rated: match.rated,
    players: [match.players[0].id, match.players[1].id],
    games,
    ending: 'completed',
    replaces,
  }
}

// The fragment of a draft with `games`. A draft with nothing in it is the
// empty fragment.
export function draftHash(
  match: Match,
  games: GamePoints[],
  replaces: Uint8Array<ArrayBuffer> | null,
  issuedAt: number,
): string {
  if (games.length === 0 && !replaces) return ''
  return base64url(encodePayload(issuedAt, resultOf(match, games, replaces)))
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
