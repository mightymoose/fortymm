import { Fragment, type CSSProperties } from 'react'
import { useSingleSelect, type SingleSelectOptionProps } from '../../components/singleSelect'
import { useTooltip } from '../../components/tooltipContext'
import {
  clockTime,
  matchLabel,
  matchScore,
  minutes,
  shortName,
  type Day,
  type FreeSlot,
  type Match,
} from './match'

// `count` minutes along a timeline, in kit.css's pixels per minute.
const along = (count: number) => `calc(${count} * var(--ppm))`

// Where a block sits on a track that starts at `from`, and how wide it is.
function position(slot: Match | FreeSlot, from: string): CSSProperties {
  const left = minutes(slot.start) - minutes(from)
  const width = minutes(slot.end) - minutes(slot.start)
  return { left: along(left), width: `calc(${width} * var(--ppm) - 6px)` }
}

// The line at the top of a block that says how its match stands, if it
// needs saying.
function SlotStatus({ match }: { match: Match }) {
  switch (match.state) {
    case 'live':
      return <span className="fm-slot__status live-marker">Live</span>
    case 'final': {
      const { won } = matchScore(match)
      return (
        <span className="fm-slot__status">
          Final{' '}
          <span className="num">
            {won[0]}–{won[1]}
          </span>
        </span>
      )
    }
    case 'offline':
      return <span className="fm-slot__status">Scorer offline</span>
    case 'conflict':
      return <span className="fm-slot__status">Needs decision</span>
    case 'upcoming':
      return match.rest ? (
        <span className="fm-slot__status rest">
          {`${match.rest.who} rests to `}
          <span className="num">{match.rest.until}</span>
        </span>
      ) : null
  }
}

// A match's schedule block as match.js's `slot()` draws it, styled by
// `.fm-slot` in styles/kit.css: its status, the players' short names and its
// time. Its tooltip and accessible name give the full names, the table and
// the time. `from` places it on a track that starts then. `selectProps`
// make it an option of a single-select group.
export function MatchSlot({
  match,
  from,
  selectProps,
}: {
  match: Match
  from?: string
  selectProps?: SingleSelectOptionProps
}) {
  const [first, second] = match.players
  const time =
    match.state === 'live' || match.state === 'offline'
      ? `since ${match.start}`
      : `${match.start}–${match.end}`
  const conflict = match.state === 'conflict' ? ` · ${match.conflict.short}` : ''
  const summary = `${first.name} vs ${second.name} · Table ${match.table} · ${time}${conflict}`
  const tooltip = useTooltip(summary)
  return (
    <button
      type="button"
      className="fm-slot"
      data-state={match.state}
      style={from ? position(match, from) : undefined}
      {...tooltip}
      {...selectProps}
    >
      <SlotStatus match={match} />
      <span className="fm-slot__names">
        <span>{shortName(first)}</span>
        <span>{shortName(second)}</span>
      </span>
      <span className="fm-slot__time">{time}</span>
      <span className="fm-sr">{summary}</span>
    </button>
  )
}

// A free gap in a table's schedule, drawn as an empty block.
export function FreeSlotBlock({ slot, from }: { slot: FreeSlot; from?: string }) {
  return (
    <div
      className="fm-slot"
      data-state="free"
      style={from ? position(slot, from) : undefined}
    >
      <span className="fm-slot__status">Free</span>
      <span className="fm-slot__time">
        {slot.start}–{slot.end}
      </span>
    </div>
  )
}

// A day's schedule as match.js's `timeline()` draws it, styled by
// `.fm-timeline` in styles/kit.css: a ruler every half hour with the time
// now, then one track of blocks per table. Its blocks are a single-select
// group of pressed buttons, as kit.js runs them. The match `initial` starts
// selected, and `onSelect` gets each match selected after it.
export function Timeline({
  day,
  initial,
  onSelect,
}: {
  day: Day
  initial: string
  onSelect: (match: Match) => void
}) {
  const matches = day.slots.filter((slot): slot is Match => slot.state !== 'free')
  const labels = matches.map(matchLabel)
  const { optionProps } = useSingleSelect(
    'pressed',
    labels,
    (label) => onSelect(matches[labels.indexOf(label)]),
    matches.findIndex((match) => match.id === initial),
  )
  const from = minutes(day.from)
  const length = minutes(day.to) - from
  const now = minutes(day.now) - from
  const ticks = Array.from({ length: Math.ceil(length / 30) }, (_, n) => n * 30)

  return (
    <div className="fm-timeline" aria-label={`Schedule, ${day.from} to ${day.to}`}>
      <span aria-hidden="true"></span>
      <div className="fm-timeline__ruler" aria-hidden="true" style={{ width: along(length) }}>
        {ticks.map((tick) => (
          <span key={tick} style={{ left: along(tick) }}>
            {clockTime(from + tick)}
          </span>
        ))}
        <span className="now" style={{ left: along(now) }}>
          Now {day.now}
        </span>
      </div>
      {day.tables.map((table) => (
        <Fragment key={table}>
          <div className="fm-timeline__table">Table {table}</div>
          <div
            className="fm-timeline__track"
            role="group"
            aria-label={`Table ${table}`}
            style={{ width: along(length) }}
          >
            {day.slots
              .filter((slot) => slot.table === table)
              .map((slot) =>
                slot.state === 'free' ? (
                  <FreeSlotBlock key={slot.id} slot={slot} from={day.from} />
                ) : (
                  <MatchSlot
                    key={slot.id}
                    match={slot}
                    from={day.from}
                    selectProps={optionProps(matches.indexOf(slot))}
                  />
                ),
              )}
            <span className="fm-timeline__now" style={{ left: along(now) }}></span>
          </div>
        </Fragment>
      ))}
    </div>
  )
}
