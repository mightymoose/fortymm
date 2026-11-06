import { useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { SegmentedControl } from '../../components/SegmentedControl'
import { dayLabel, opponentsOf, timeLabel, type Dashboard, type PlayerSummary, type RecentMatch, matchCountText, recordText, streakText } from './dashboard'
import { useAttentionCopy } from './attention'
import { NewMatchLink, ResultText, Skeleton } from './parts'

// Option C, "Day by day": one narrow column. What needs doing as rows, only
// when something does, then the matches as a feed grouped by day, one
// sentence each. An account that manages players switches between them.
export function OptionC({ dashboard, now }: { dashboard: Dashboard; now: Date }) {
  const copy = useAttentionCopy()
  const everyone = [dashboard.me, ...dashboard.managed].slice(0, 4)
  const [shownId, setShownId] = useState(dashboard.me.player.id)
  const shown = everyone.find((summary) => summary.player.id === shownId) ?? dashboard.me
  const labelOf = (summary: PlayerSummary) => (summary === dashboard.me ? 'You' : summary.player.display_name)

  return (
    <div className="dash dash-c">
      <header className="dash-c__head">
        <h1 className="dash__title">Home</h1>
        {dashboard.canCreateMatch && <NewMatchLink size="sm" />}
      </header>

      {dashboard.attention.length > 0 && (
        <section aria-labelledby="dash-c-attention">
          <h2 className="h3" id="dash-c-attention">
            Needs your attention
          </h2>
          <ul className="fm-list fm-list--divided">
            {dashboard.attention.map((item) => {
              const { title, body, action } = copy(item, 'sm')
              return (
                <li key={item.kind} className="dash-c__task">
                  <div>
                    <p className="dash__name">{title}</p>
                    <p className="meta">{body}</p>
                  </div>
                  {action}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="dash-c-feed" className="dash-c__feed">
        <div className="dash__section-head">
          <h2 className="h3" id="dash-c-feed">
            {shown === dashboard.me ? 'Your matches' : `${shown.player.display_name}’s matches`}
          </h2>
        </div>
        {everyone.length > 1 && (
          <SegmentedControl
            label="Whose matches"
            options={everyone.map(labelOf)}
            onChange={(label) => setShownId(everyone.find((s) => labelOf(s) === label)?.player.id ?? shownId)}
          />
        )}
        {summaryLine(shown) && <p className="meta">{summaryLine(shown)}</p>}
        <Feed matches={shown.player.recent_matches} more={shown.player.match_count - shown.player.recent_matches.length} now={now} />
      </section>
    </div>
  )
}

function summaryLine(summary: PlayerSummary): string | null {
  if (summary.player.match_count === 0) return null
  const parts = [matchCountText(summary.player.match_count)]
  if (summary.form.length > 0) parts.push(`${recordText(summary)} in the last ${summary.form.length}`)
  const streak = streakText(summary)
  if (streak) parts.push(streak.toLowerCase())
  return `${parts.join(' · ')}.`
}

function Feed({ matches, more, now }: { matches: readonly RecentMatch[]; more: number; now: Date }) {
  if (matches.length === 0) return <EmptyState title="No matches yet">Your matches show here after you play.</EmptyState>
  const days = new Map<string, RecentMatch[]>()
  for (const match of matches) {
    const day = dayLabel(match.played_at, now)
    days.set(day, [...(days.get(day) ?? []), match])
  }
  return (
    <>
      {[...days].map(([day, played]) => (
        <section key={day} aria-label={day} className="dash-c__day">
          <h3 className="fm-section-title">{day}</h3>
          <ul className="fm-list fm-list--divided">
            {played.map((match) => (
              <li key={match.id} className="dash-c__match">
                <span className="num meta">{timeLabel(match.played_at)}</span>
                <span>
                  <ResultText match={match} /> <span className="dash-c__against">against {opponentsOf(match)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more > 0 && <p className="meta">{more === 1 ? '1 earlier match' : `${more} earlier matches`}</p>}
    </>
  )
}

export function OptionCSkeleton() {
  return (
    <div className="dash dash-c" aria-hidden="true">
      <header className="dash-c__head">
        <Skeleton width={120} height={36} />
      </header>
      <section className="dash-c__feed">
        <Skeleton width={140} height={20} />
        <Skeleton width={220} height={14} />
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} width="90%" height={20} />
        ))}
      </section>
    </div>
  )
}
