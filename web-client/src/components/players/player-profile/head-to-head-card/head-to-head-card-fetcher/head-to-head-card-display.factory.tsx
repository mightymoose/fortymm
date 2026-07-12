import type { HeadToHeadCardDisplayProps } from './head-to-head-card-display'
import type {
  FrequentOpponentView,
  HeadToHeadView,
  ViewerRecordView,
} from './head-to-head-card-query'

/** One frequent-opponent row: the **profiled player's** record against them. */
export function buildFrequentOpponentView(
  overrides: Partial<FrequentOpponentView> = {},
): FrequentOpponentView {
  return {
    id: 'p-21',
    username: 'nia.brandt',
    record: '6–2',
    meetings: '8 meetings',
    winShare: 0.75,
    ...overrides,
  }
}

/**
 * The **viewer's** record against the profiled player — 1–4, deliberately
 * lopsided *and* deliberately a losing one.
 *
 * `A 4–1 B` and `B 1–4 A` are the same head-to-head said two ways
 * (`CONTEXT.md`), so a symmetric fixture could not tell a card that read this
 * from the player's side from one that read it from the viewer's — which is the
 * only thing this card has to get right.
 */
export function buildViewerRecordView(
  overrides: Partial<ViewerRecordView> = {},
): ViewerRecordView {
  return {
    opponent: { id: 'p-1', username: 'perky-ringtail' },
    neverMet: false,
    record: '1–4',
    meetings: '5 meetings',
    lastMeeting: 'Last met Mar 14, 2025',
    ...overrides,
  }
}

/** The viewer has **never played** this player — zero meetings, which is what
 * every guest has. Not an error, not an empty record: an invitation. */
export function buildNeverMetRecordView(
  overrides: Partial<ViewerRecordView> = {},
): ViewerRecordView {
  return buildViewerRecordView({
    neverMet: true,
    record: '0–0',
    meetings: null,
    lastMeeting: null,
    ...overrides,
  })
}

/** The card as a **stranger** sees it: your own record leads, their frequent
 * opponents sit below it. */
export function buildHeadToHeadView(
  overrides: Partial<HeadToHeadView> = {},
): HeadToHeadView {
  return {
    playerName: 'perky-ringtail',
    versusViewer: buildViewerRecordView(),
    frequentOpponents: [
      buildFrequentOpponentView(),
      buildFrequentOpponentView({
        id: 'p-22',
        username: 'omar.faye',
        record: '2–3',
        meetings: '5 meetings',
        winShare: 0.4,
      }),
      buildFrequentOpponentView({
        id: 'p-23',
        username: 'sable.rook',
        record: '1–1',
        meetings: '2 meetings',
        winShare: 0.5,
      }),
    ],
    ...overrides,
  }
}

/**
 * The card on **your own** profile: `versusViewer` is `null` — you have no record
 * against yourself and cannot be challenged to play yourself — so all that is left
 * is the frequent-opponents list.
 */
export function buildOwnProfileHeadToHeadView(
  overrides: Partial<HeadToHeadView> = {},
): HeadToHeadView {
  return buildHeadToHeadView({
    playerName: 'rita.kovac',
    versusViewer: null,
    ...overrides,
  })
}

/** Props for `HeadToHeadCardDisplay`. */
export function buildHeadToHeadCardDisplayProps(
  overrides: Partial<HeadToHeadCardDisplayProps> = {},
): HeadToHeadCardDisplayProps {
  return { headToHead: buildHeadToHeadView(), ...overrides }
}
