import { Trophy } from 'lucide-react'

export interface ChampionBannerProps {
  /** The champion's display name, already joined from an entry id to a username by the
   * view-model (`data/finishes`, `data/standings`) — never a raw id. */
  name: string
  /** The `data-testid` the panel wants on the callout (`finishes-champion-${event.id}`,
   * `standings-champion-${event.id}`), passed through so each panel keeps its own hook. */
  testId: string
}

/**
 * A decided event's **champion**, in the app's "featured" voice (`web-client/CLAUDE.md`,
 * design system: the `--ball-500` tint + `var(--shadow-glow)`): a trophy, the "Champion"
 * label, and the winner's name. Shared, byte-for-byte, by `FinishesPanel` (single-
 * elimination) and `StandingsPanel` (round-robin) — the only per-panel differences are the
 * name and the `data-testid`, both passed in.
 *
 * Not an `Alert`: it is not the app talking back to an action and it does not dismiss, it is
 * a fact about the finished event. Each panel gates it on its own `complete && champion`
 * condition; this is a pure view over the two props.
 */
export const ChampionBanner = ({ name, testId }: ChampionBannerProps) => (
  <p
    data-testid={testId}
    className="mt-1.5 flex items-center gap-1.5 rounded-[10px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] px-3 py-2 text-[13px] font-medium text-[color:var(--fg-1)] [box-shadow:var(--shadow-glow)]"
  >
    <Trophy size={14} className="text-[color:var(--ball-500)]" />
    <span className="text-[color:var(--fg-3)]">Champion</span>
    <span className="text-[color:var(--ball-500)]">{name}</span>
  </p>
)
