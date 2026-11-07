import type { Side } from './board'

// What the approval page offers whoever opens a result link.
// `approve`: the viewer plays the side that hasn't approved yet.
// `waiting`: the viewer's side approved, and the other side hasn't. That is
// the submitter, who must never add a second signature.
// `send`: both sides approved, and this device sends the match's results,
// whichever side approved last. The submitter who reopens the approved
// link may be the one who lands it. `approvedHere` is whether the viewer's
// side approved last, on this device.
// `approved-here`: the viewer's side approved last, on this device, which
// can't send it. `handBack` is whether the opponent's phone could.
// `approved`: both sides approved elsewhere, and this device can't send it.
// `final`: FortyMM has the match's final result, so a link still waiting
// for an approval is out of date. `side` is null for anyone else.
// `not-yours`: a signed-in account that plays neither side.
// `sign-in`: a guest who plays neither side, who may be the player on
// another account. A signed-out visitor is a guest too.
export type Approval =
  | { kind: 'approve'; side: Side }
  | { kind: 'waiting'; side: Side }
  | { kind: 'send'; side: Side; approvedHere: boolean }
  | { kind: 'approved-here'; side: Side; handBack: boolean }
  | { kind: 'approved'; side: Side }
  | { kind: 'final'; side: Side | null }
  | { kind: 'not-yours' }
  | { kind: 'sign-in' }

// Where the match's results reach FortyMM from. `here`: this device sends
// them, as an API match whose viewer may score it. `elsewhere`: an API
// match this account can't score, such as a new guest's, so only the other
// phone can send it. `nowhere`: a demo match, which FortyMM doesn't have.
export type Sync = 'here' | 'elsewhere' | 'nowhere'

export type Viewing = {
  // The side each signature approved for, in signing order.
  signers: readonly Side[]
  // The players' ids, side 0 first.
  players: readonly [string, string]
  account: { kind: 'guest' | 'verified'; playerId: string }
  sync: Sync
  // Whether FortyMM says the match is final. False until it answers.
  final: boolean
  // The side FortyMM says the viewer plays, which also knows players merged
  // since the result was signed. Undefined until it answers, or offline.
  // Null when FortyMM says neither side, which isn't the last word: an
  // account may approve for a player it manages, and FortyMM checks each
  // signature's account when the result arrives. So the page goes by the
  // link's players then, as it does offline.
  serverSide?: Side | null
}

export function approvalFor({ signers, players, account, sync, final, serverSide }: Viewing): Approval {
  const side = serverSide ?? ([0, 1] as const).find((s) => players[s] === account.playerId)
  const signed = new Set(signers)
  if (final && signed.size < 2) return { kind: 'final', side: side ?? null }
  if (side === undefined) return account.kind === 'guest' ? { kind: 'sign-in' } : { kind: 'not-yours' }
  if (!signed.has(side)) return { kind: 'approve', side }
  if (!signed.has(side === 0 ? 1 : 0)) return { kind: 'waiting', side }
  const approvedHere = signers[signers.length - 1] === side
  if (sync === 'here') return { kind: 'send', side, approvedHere }
  if (approvedHere) return { kind: 'approved-here', side, handBack: sync === 'elsewhere' }
  return { kind: 'approved', side }
}
