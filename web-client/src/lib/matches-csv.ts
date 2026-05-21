import type { MatchListRow } from '@/api/matches'

const HEADERS = [
  'Match ID',
  'Created',
  'Status',
  'League',
  'Side 1',
  'Side 2',
  'Score',
  'Best of',
] as const

function findSide(row: MatchListRow, sideNumber: 1 | 2) {
  return (
    row.sides.find((s) => s.side_number === sideNumber) ??
    (sideNumber === 1 ? (row.sides[0] ?? null) : null)
  )
}

function players(side: ReturnType<typeof findSide>): string {
  return side ? side.players.map((p) => p.username).join(' & ') : ''
}

function score(row: MatchListRow): string {
  if (row.status !== 'in_progress' && row.status !== 'completed') return ''
  const s1 = findSide(row, 1)
  const s2 = findSide(row, 2)
  if (!s1 || !s2) return ''
  return `${s1.games_won}-${s2.games_won}`
}

/** Quote a field iff it contains a comma, quote, or newline (RFC 4180). */
function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Serialize match-list rows to CSV (RFC 4180, CRLF line breaks). Column shape
 * mirrors what the matches table shows: id, created, status, league, both
 * sides, score, best-of.
 */
export function matchesToCsv(rows: MatchListRow[]): string {
  const lines = [HEADERS.join(',')]
  for (const row of rows) {
    const cells = [
      row.id,
      row.created_at,
      row.status_label,
      row.league.name,
      players(findSide(row, 1)),
      players(findSide(row, 2)),
      score(row),
      String(row.best_of),
    ]
    lines.push(cells.map((c) => escapeCsv(String(c))).join(','))
  }
  return lines.join('\r\n')
}

/** Trigger a client-side download of `csv` as `filename`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
