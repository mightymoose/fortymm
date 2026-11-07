import { describe, expect, it } from 'vitest'
import { approvalFor, type Viewing } from './approval'

const A = 'a0000000-0000-4000-8000-000000000000'
const B = 'b0000000-0000-4000-8000-000000000000'
const C = 'c0000000-0000-4000-8000-000000000000'

const viewing = (fields: Partial<Viewing>): Viewing => ({
  signers: [0],
  players: [A, B],
  account: { kind: 'guest', playerId: B },
  sync: 'here',
  final: false,
  ...fields,
})

const submitter = { kind: 'guest', playerId: A } as const

describe('approvalFor', () => {
  it('offers Approve to the player of the side that hasn’t approved', () => {
    expect(approvalFor(viewing({}))).toEqual({ kind: 'approve', side: 1 })
    expect(approvalFor(viewing({ signers: [1], account: { kind: 'verified', playerId: A } }))).toEqual({
      kind: 'approve',
      side: 0,
    })
  })

  it('has the submitter wait for the other side', () => {
    expect(approvalFor(viewing({ account: { kind: 'verified', playerId: A } }))).toEqual({ kind: 'waiting', side: 0 })
  })

  it('has the submitter wait even when their side signed twice', () => {
    expect(approvalFor(viewing({ signers: [0, 0], account: submitter }))).toEqual({ kind: 'waiting', side: 0 })
  })

  it('sends an approved result from a device that sends results, whichever side approved last', () => {
    expect(approvalFor(viewing({ signers: [0, 1] }))).toEqual({ kind: 'send', side: 1, approvedHere: true })
    expect(approvalFor(viewing({ signers: [0, 1], account: submitter }))).toEqual({
      kind: 'send',
      side: 0,
      approvedHere: false,
    })
  })

  it('has a player who approved here but can’t send it hand it back to the other phone', () => {
    expect(approvalFor(viewing({ signers: [0, 1], sync: 'elsewhere' }))).toEqual({
      kind: 'approved-here',
      side: 1,
      handBack: true,
    })
    expect(approvalFor(viewing({ signers: [0, 1], sync: 'nowhere' }))).toEqual({
      kind: 'approved-here',
      side: 1,
      handBack: false,
    })
  })

  it('shows a result approved elsewhere as approved by both when this device can’t send it', () => {
    expect(approvalFor(viewing({ signers: [0, 1], sync: 'elsewhere', account: submitter }))).toEqual({
      kind: 'approved',
      side: 0,
    })
  })

  it('shows a link still waiting for an approval as out of date once the match is final', () => {
    expect(approvalFor(viewing({ final: true }))).toEqual({ kind: 'final', side: 1 })
    expect(approvalFor(viewing({ final: true, account: submitter }))).toEqual({ kind: 'final', side: 0 })
    expect(approvalFor(viewing({ final: true, account: { kind: 'guest', playerId: C } }))).toEqual({
      kind: 'final',
      side: null,
    })
    expect(approvalFor(viewing({ final: true, signers: [0, 1] }))).toEqual({ kind: 'send', side: 1, approvedHere: true })
  })

  it('tells a verified account that plays neither side it isn’t theirs, and asks a guest to sign in', () => {
    expect(approvalFor(viewing({ account: { kind: 'verified', playerId: C } }))).toEqual({ kind: 'not-yours' })
    expect(approvalFor(viewing({ account: { kind: 'guest', playerId: C } }))).toEqual({ kind: 'sign-in' })
  })

  it('takes the side FortyMM says the viewer plays, as after a merge', () => {
    expect(approvalFor(viewing({ account: { kind: 'verified', playerId: C }, serverSide: 1 }))).toEqual({
      kind: 'approve',
      side: 1,
    })
  })

  it('goes by the result’s players when FortyMM says the viewer plays neither side', () => {
    expect(approvalFor(viewing({ serverSide: null }))).toEqual({ kind: 'approve', side: 1 })
  })
})
