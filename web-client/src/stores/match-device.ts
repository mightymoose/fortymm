import { onChange } from '../changes.ts'
import { commit, type CommitFailure } from '../journal.ts'
import { keeping } from '../persist.ts'
import { loadMatch, loadMatches } from '../storage.ts'
import { missingMatch, type Failure, type MatchSource } from './match-source.ts'

// This device's matches, as signed records in IndexedDB: the source
// (match-source.ts) the app's match stores read and write
// (PLAN-match-store-and-sync.md §2, task G2). What it keeps outlives the
// page: a reload, closing the browser or losing the connection keeps every
// match and game.
//
// - create is one commit (src/journal.ts) of one record, the `match`: this
//   device's own player on one side, and on the other an anonymous side, a
//   side with no players (core/FORMAT.md section 5), and the terms the core
//   makes of the best of and rated. No player record is made for the
//   opponent: the empty side is "Anonymous". The core's matchBody throws for
//   rated terms with an anonymous side, so a rated create is a caller's bug
//   that makes commit throw, keeping nothing; the new match form only ever
//   asks for unrated.
// - saveGame is one commit that reads the match as kept, inside the append
//   lock (the held store's loadMatch), asks `decide` about it there, and
//   makes one `score` record: game `game`'s score, or "cleared", naming as
//   replaced every entry current for that game. So no other write, in this
//   tab or another, comes between what `decide` saw and what is kept, and a
//   correction or a clear is one more record. What `decide` refuses keeps
//   nothing. A save of the score the game already has, as its one current
//   entry, keeps nothing and answers ok: a record is signed for good, and a
//   second press shouldn't make one. A game with two current entries (two
//   devices saved it apart) still gets the record that settles them.
// - read and list are storage's loadMatch and loadMatches: the matches view
//   the core computed from the records, with no lock and no core.
// - onChange is storage's announcement (src/changes.ts): this tab's writes
//   and every other tab's, and 'all' when the page is shown again.
//
// The id of a match is the core's match id, in hex. Any other string is no
// match: read gives null and a save is `missingMatch`.
//
// Nothing here throws for an answer it can give: a device that won't store,
// lock, sign or load the core is the stores' Failure or Unavailable.

export const matchDevice: MatchSource = {
  async create({ format, rated }) {
    const created = await commit<string>(async ({ core, me, make }) => {
      const terms = core.termsBytes(format.bestOf, rated)
      const match = await make((signer) => core.matchBody(...signer, [[me], []], terms))
      return { records: [match], value: hex(core.id(match)) }
    })
    if (created.ok) {
      // The first record kept: the browser is asked to keep the data, in
      // the background (src/persist.ts).
      void keeping.afterKept()
      return { ok: true, matchId: created.value }
    }
    // The draft refuses nothing; a refusal would be a bug, told as a match
    // that couldn't be made.
    return { ok: false, reason: 'message' in created ? 'signing-unavailable' : failureOf(created.reason) }
  },

  async saveGame(matchId, game, decide) {
    const saved = await commit<null>(async ({ core, store, make }) => {
      const loaded = await store.loadMatch(matchId)
      if (!loaded.ok) return loaded
      if (loaded.match === null) return { refused: missingMatch }
      const decided = decide(loaded.match)
      if ('reason' in decided) return { refused: decided }
      const current = loaded.match.current[game - 1] ?? []
      const { score } = decided
      // The score the game already has, as its one current entry: nothing
      // to keep. Two current entries are still settled by a new record.
      if (score !== null && current.length === 1 && sameScore(loaded.match.games[game - 1], score)) {
        return { records: [], value: null }
      }
      const replaces = current.map(bytes)
      const value = core.scoreValue(score === null ? null : [score[0], score[1]])
      const record = await make((signer) =>
        core.scoreBody(...signer, bytes(matchId), game, value, replaces),
      )
      return { records: [record], value: null }
    })
    if (saved.ok) return { ok: true }
    if ('message' in saved) return saved
    return { ok: false, reason: failureOf(saved.reason) }
  },

  read: (matchId) => loadMatch(matchId),

  list: () => loadMatches(),

  onChange: (listener) => onChange((change) => listener(change.matches)),
}

// A commit that kept nothing, other than a refusal, as the stores' Failure.
// record-refused is a draft giving a record commit didn't make, or one
// append doesn't keep: these drafts give only what make made, of the kinds
// append keeps, so it can't happen. Should it, it is told as a record that
// couldn't be made.
function failureOf(reason: CommitFailure): Failure['reason'] {
  return reason === 'record-refused' ? 'signing-unavailable' : reason
}

function sameScore(kept: readonly [number, number] | null | undefined, score: readonly [number, number]) {
  return kept != null && kept[0] === score[0] && kept[1] === score[1]
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// A match id (hex) as the core takes it: kept ids only, so always 64 hex
// digits.
function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}
