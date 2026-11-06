import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { dayLabel, opponentsOf, type Dashboard, type PlayerSummary, matchCountText, recordText, streakText } from './dashboard'
import { useAttentionCopy } from './attention'
import { FormStrip, NewMatchLink, ResultText, Skeleton } from './parts'

// Option B, "Your game": the numbers first. A record card with the last
// five results beside a table of them, then a table of the players the
// account manages. A player with no matches gets a first-match card in the
// grid's place.
export function OptionB({ dashboard, now }: { dashboard: Dashboard; now: Date }) {
  const copy = useAttentionCopy()
  const { me } = dashboard
  const firstMatch = dashboard.attention.some((item) => item.kind === 'first-match')
  const alerts = dashboard.attention.filter((item) => item.kind !== 'first-match')

  return (
    <div className="dash dash-b">
      <header className="dash-b__head">
        <div>
          <h1 className="dash__title">Your game</h1>
          <p className="meta">{me.player.display_name}</p>
        </div>
        {dashboard.canCreateMatch && !firstMatch && <NewMatchLink variant="secondary" />}
      </header>

      {alerts.map((item) => {
        const { title, body, action } = copy(item, 'sm')
        return (
          <div key={item.kind} className="fm-alert fm-alert--warning">
            <Icon name="alert" />
            <p className="fm-alert__title">{title}</p>
            <p className="fm-alert__body">{body}</p>
            <div className="fm-alert__actions">{action}</div>
          </div>
        )
      })}

      <div className="dash-b__grid">
        <RecordCard summary={me} />
        {firstMatch ? (
          <Card title="Log your first match" actions={<NewMatchLink size="lg" />}>
            <p className="dash__body">
              Pick who you played and the format, then keep score at the table. Your record starts with your first
              result.
            </p>
          </Card>
        ) : (
          <RecentCard summary={me} now={now} />
        )}
      </div>

      {dashboard.managed.length > 0 && <ManagedTable players={dashboard.managed} now={now} />}
    </div>
  )
}

function RecordCard({ summary }: { summary: PlayerSummary }) {
  const streak = streakText(summary)
  const played = summary.form.length
  return (
    <Card title="Your record" status={streak && <span className="fm-status">{streak}</span>}>
      {played > 0 ? (
        <>
          <p className="dash-b__record">
            <span className="num">{recordText(summary)}</span>
            <span className="meta">in your last {played}</span>
          </p>
          <FormStrip form={summary.form} />
        </>
      ) : (
        <p className="dash-b__record">
          <span className="num">0–0</span>
          <span className="meta">No results yet</span>
        </p>
      )}
      <DetailList
        details={[
          { term: 'Matches', value: summary.player.match_count, numeric: true },
          ...(summary.last ? [{ term: 'Last match', value: <ResultText match={summary.last} /> }] : []),
        ]}
      />
    </Card>
  )
}

function RecentCard({ summary, now }: { summary: PlayerSummary; now: Date }) {
  const matches = summary.player.recent_matches
  return (
    <Card
      title="Recent matches"
      status={summary.form.length > 0 && <span className="meta num">{recordText(summary)} · last {summary.form.length}</span>}
    >
      {matches.length > 0 ? (
        <div className="fm-scroll">
          <table className="fm-table">
            <thead>
              <tr>
                <th>Opponent</th>
                <th>Result</th>
                <th className="n">When</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => (
                <tr key={match.id}>
                  <td className="dash__name">{opponentsOf(match)}</td>
                  <td>
                    <ResultText match={match} />
                  </td>
                  <td className="n dash-b__when">{dayLabel(match.played_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No matches yet">Log one after you play.</EmptyState>
      )}
    </Card>
  )
}

function ManagedTable({ players, now }: { players: readonly PlayerSummary[]; now: Date }) {
  return (
    <section aria-labelledby="dash-b-managed">
      <h2 className="h3" id="dash-b-managed">
        Players you manage
      </h2>
      <div className="fm-scroll">
        <table className="fm-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="n">Matches</th>
              <th>Last {Math.max(...players.map((p) => p.form.length), 1)}</th>
              <th className="n">Last played</th>
            </tr>
          </thead>
          <tbody>
            {players.map((summary) => (
              <tr key={summary.player.id}>
                <td className="dash__name">
                  {summary.player.display_name}
                  {summary.player.open_question && <span className="meta"> · Is this you?</span>}
                </td>
                <td className="n">{summary.player.match_count}</td>
                <td>{summary.form.length > 0 ? <FormStrip form={summary.form} /> : <span className="meta">No results</span>}</td>
                <td className="n dash-b__when">{summary.last ? dayLabel(summary.last.played_at, now) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta">{matchCountText(players.reduce((sum, p) => sum + p.player.match_count, 0))} between them.</p>
    </section>
  )
}

export function OptionBSkeleton() {
  return (
    <div className="dash dash-b" aria-hidden="true">
      <header className="dash-b__head">
        <div>
          <Skeleton width={200} height={36} />
          <Skeleton width={120} height={14} />
        </div>
      </header>
      <div className="dash-b__grid">
        <div className="fm-card">
          <Skeleton width={120} height={20} />
          <Skeleton width={120} height={48} />
          <Skeleton width={180} height={28} />
        </div>
        <div className="fm-card">
          <Skeleton width={160} height={20} />
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} width="100%" height={20} />
          ))}
        </div>
      </div>
    </div>
  )
}
