import type { components } from '@/api/schema'

type HeadToHeadOpponent = components['schemas']['HeadToHeadOpponent']
type HeadToHeadRecord = components['schemas']['HeadToHeadRecord']
type ViewerHeadToHead = components['schemas']['ViewerHeadToHead']
type PlayerHeadToHead = components['schemas']['PlayerHeadToHead']

/** The player the default profile bundle is about (`buildPlayerDetail`). The
 * viewer's record hangs off *them*, so the two fixtures have to agree on who
 * "them" is. */
const PROFILED_PLAYER: HeadToHeadOpponent = {
  id: 'p-1',
  username: 'rita.kovac',
}

/** A named player on the other side of a head-to-head. Both fields are required
 * on the wire, unlike a match row's opponent — a solo match has *nobody* on the
 * other side, so it can never be a **meeting** (`CONTEXT.md`) and can never show
 * up here. */
export function buildHeadToHeadOpponent(
  overrides: Partial<HeadToHeadOpponent> = {},
): HeadToHeadOpponent {
  return { id: 'p-9', username: 'perky-ringtail', ...overrides }
}

/**
 * One row of **frequent opponents** — the *profiled player's* record against
 * somebody they meet often.
 *
 * `meetings` is `wins + losses` and the API derives it rather than storing it, so
 * this fixture derives it too: a fixture whose `meetings` disagreed with its W–L
 * would let a card that printed a nonsense win-share bar pass.
 */
export function buildHeadToHeadRecord(
  overrides: Partial<Omit<HeadToHeadRecord, 'meetings'>> = {},
): HeadToHeadRecord {
  const wins = overrides.wins ?? 6
  const losses = overrides.losses ?? 2
  return {
    opponent: buildHeadToHeadOpponent(),
    ...overrides,
    wins,
    losses,
    meetings: wins + losses,
  }
}

/**
 * The **viewer's own** record against the profiled player — "you are 1–4 against
 * them", never "they are 4–1 against you".
 *
 * Deliberately **lopsided**, and deliberately a *losing* record: `A 4–1 B` and
 * `B 1–4 A` are the same head-to-head said two ways (`CONTEXT.md` §
 * *Head-to-head*), so a card that read this from the *player's* side instead of
 * the viewer's would print "4–1" — a symmetric 2–2 fixture could not tell the two
 * apart, and would let that bug ship.
 *
 * `opponent` is the **profiled player** (the viewer's opponent), which is what the
 * never-met CTA prefills the match with.
 */
export function buildViewerHeadToHead(
  overrides: Partial<Omit<ViewerHeadToHead, 'meetings'>> = {},
): ViewerHeadToHead {
  const wins = overrides.wins ?? 1
  const losses = overrides.losses ?? 4
  return {
    opponent: PROFILED_PLAYER,
    last_meeting: '2025-03-14T18:30:00Z',
    ...overrides,
    wins,
    losses,
    meetings: wins + losses,
  }
}

/**
 * The viewer has **never played** the profiled player: present, with zero
 * meetings — not `null`, and not an error.
 *
 * This is the *common* case, not an edge one: a guest session is minted for
 * anyone who lands on a profile link, and a guest has played nobody (ADR-0915).
 * It is the first thing a brand-new visitor sees, so the card answers it with an
 * invitation and a Start-a-match CTA — which needs `opponent` populated, which is
 * exactly why the API sends the block rather than nulling it.
 */
export function buildNeverMetHeadToHead(
  overrides: Partial<Omit<ViewerHeadToHead, 'meetings'>> = {},
): ViewerHeadToHead {
  return buildViewerHeadToHead({
    wins: 0,
    losses: 0,
    last_meeting: null,
    ...overrides,
  })
}

/**
 * The profile bundle's head-to-head block, as a **stranger** sees it: the
 * viewer's own 1–4 record against this player, plus the player's three most-met
 * opponents underneath as secondary context.
 *
 * Those three are deliberately **different people** from the opponents on the
 * bundle's six recent-match rows (kai.zhou, lin.wu, grace.hopper…). Not fussiness:
 * frequent opponents are an all-time aggregate over a player's whole history, so
 * the two lists genuinely need not overlap — and a fixture that reused the same
 * names would put each of them on the page *twice*, quietly breaking every
 * page-wide `getByText(<name>)` in the profile's other suites.
 */
export function buildPlayerHeadToHead(
  overrides: Partial<PlayerHeadToHead> = {},
): PlayerHeadToHead {
  return {
    versus_viewer: buildViewerHeadToHead(),
    frequent_opponents: [
      buildHeadToHeadRecord({
        opponent: { id: 'p-21', username: 'nia.brandt' },
        wins: 6,
        losses: 2,
      }),
      buildHeadToHeadRecord({
        opponent: { id: 'p-22', username: 'omar.faye' },
        wins: 2,
        losses: 3,
      }),
      buildHeadToHeadRecord({
        opponent: { id: 'p-23', username: 'sable.rook' },
        wins: 1,
        losses: 1,
      }),
    ],
    ...overrides,
  }
}

/**
 * The head-to-head block on **your own** profile: no `versus_viewer` at all,
 * because you cannot have a record against yourself — and the card must not offer
 * to start a match against you either (ADR-0915). All that is left is the
 * frequent-opponents list.
 *
 * The API expresses "the caller *is* this player" by omitting the block, so this
 * is the shape that decides the card's whole structure.
 */
export function buildSelfHeadToHead(
  overrides: Partial<PlayerHeadToHead> = {},
): PlayerHeadToHead {
  return buildPlayerHeadToHead({ versus_viewer: null, ...overrides })
}

/** A player nobody has met yet — the profile of someone with no decided matches
 * at all: no viewer record to speak of, and no frequent opponents either. */
export function buildEmptyHeadToHead(
  overrides: Partial<PlayerHeadToHead> = {},
): PlayerHeadToHead {
  return buildPlayerHeadToHead({
    versus_viewer: buildNeverMetHeadToHead(),
    frequent_opponents: [],
    ...overrides,
  })
}
