import type { TwoStageView } from '../../../../data/two-stage'
import { ChampionBanner } from '../champion-banner'
import { FinishesPanel } from '../finishes/finishes-panel'
import { StandingsPanel } from '../standings/standings-panel'

export interface TwoStagePanelProps {
  /** The event the results belong to — its id is what every hook on this block hangs off
   * (`two-stage-champion-…`, and, through the two panels it composes, `standings-panel-…`
   * and `finishes-panel-…`). */
  eventId: string
  /** The event's name, for the finishes table's accessible label ("Finishes for …") — a
   * screen reader meets that table out of context and needs to know whose placements
   * these are. */
  eventName: string
  /** The two-stage results to render, already selected and joined to names
   * (`eventStandingsThenFinishes`). **Never null**: whether an event *has* two-stage results
   * is the caller's decision, not this block's. */
  twoStage: TwoStageView
}

/**
 * A **round-robin-then-knockout** event's results on its card in the Events tab (ADR
 * 20260727): the champion, then the pool stage's standings, then the knockout stage's
 * finishes — one event's story in the order it was played.
 *
 * ## It composes; it does not fork
 *
 * The two stages are rendered by the **same** `StandingsPanel` and `FinishesPanel` a pure
 * round-robin and a pure single-elimination event get. They take their data as props for
 * exactly this reason: a two-stage event's pool table is a pool table, and its placement
 * list is a placement list — a bespoke pair here would be two more implementations to keep
 * in step, and the day one of them gained a column the other would quietly lack it.
 *
 * ## One champion, and it is the BRACKET's
 *
 * The banner is rendered **here**, above both stages, and the sub-views arrive with no
 * champion of their own (`eventStandingsThenFinishes`) — so a card can never show two.
 * The name in it is the knockout final's winner, never the top of a pool table: in this
 * format the pool stage only seeds the bracket, so leading a pool wins nothing. The two
 * are routinely different people, which is precisely why reading it off the standings
 * would be a bug that still *looks* like a champion.
 *
 * It appears only when the event is **complete** — both stages decided — and has a
 * champion. A mid-flight event (pools done, final unplayed) shows its standings and its
 * partial finishes with **no banner**, which is the honest read: nobody has won it yet.
 */
export const TwoStagePanel = ({
  eventId,
  eventName,
  twoStage,
}: TwoStagePanelProps) => (
  <div data-testid={`two-stage-panel-${eventId}`}>
    {/* The champion — the whole event's result, in the app's "featured" voice (the same
        `ChampionBanner` the other two blocks use). Above both stages because it is a fact
        about the event, not about either stage; gated on the event being decided. */}
    {twoStage.complete && twoStage.champion !== null && (
      <ChampionBanner
        name={twoStage.champion}
        testId={`two-stage-champion-${eventId}`}
      />
    )}

    {/* Stage one, then stage two — pools above the bracket they seeded. */}
    <StandingsPanel eventId={eventId} standings={twoStage.standings} />
    <FinishesPanel
      eventId={eventId}
      eventName={eventName}
      finishes={twoStage.finishes}
    />
  </div>
)
