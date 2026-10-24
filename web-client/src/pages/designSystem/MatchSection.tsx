import { EmptyState } from '../../components/EmptyState'
import { Meter } from '../../components/Meter'
import { RestIndicator } from '../../components/RestIndicator'
import { useSingleSelect } from '../../components/singleSelect'
import { DemoButton } from './DemoButton'
import { Example, GallerySection } from './GallerySection'
import { day, findMatch, matchLabel, minutes, type FreeSlot } from './match'
import { MatchRow } from './MatchRow'
import { ScorePad } from './ScorePad'
import { FreeSlotBlock, MatchSlot } from './Timeline'

// The Match row example's matches: one of each state.
const rowMatches = ['a2', 'c2', 'c3', 'a1', 'b3'].map(findMatch)

// The Schedule blocks example's blocks, the free gap on Table 2 last.
const blockMatches = ['a1', 'a2', 'b3', 'c3', 'd1'].map(findMatch)
const freeSlot = day.slots.find((slot): slot is FreeSlot => slot.id === 'b2')!

// The rest the Rest indicator example's meter counts down, at the schedule's
// time now.
const rest = { until: '11:55', length: 15 }
const restLeft = minutes(rest.until) - minutes(day.now)

// The Schedule blocks example: a block per state, a single-select group of
// pressed buttons with none pressed to start with.
function ScheduleBlocks() {
  const { optionProps } = useSingleSelect(
    'pressed',
    blockMatches.map(matchLabel),
    undefined,
    null,
  )
  return (
    <div className="doc-row" style={{ alignItems: 'stretch' }}>
      {blockMatches.map((match, index) => (
        <MatchSlot key={match.id} match={match} selectProps={optionProps(index)} />
      ))}
      <FreeSlotBlock slot={freeSlot} />
    </div>
  )
}

// The design system page's Match components section: the reference
// gallery's `section-match`, with its Match row, Empty and disconnected,
// Score entry and game history, Schedule blocks and Rest indicator examples.
export function MatchSection() {
  return (
    <GallerySection
      id="match"
      title="Match components"
      lead="FortyMM's own parts. Names wrap rather than truncate. Games won sit in a small box; current points are the big number."
    >
      <Example
        testId="ex-match-row"
        title="Match row"
        description={`Columns: name · serve · games won · points. Games and Points are labelled once per list. "Game scores" opens the full history — a tap target, so it works on touch.`}
      >
        <div className="fm-matches" style={{ maxWidth: 620 }}>
          {rowMatches.map((match) => (
            <MatchRow key={match.id} match={match} gameScores />
          ))}
        </div>
      </Example>
      <Example
        testId="ex-empty-and-disconnected"
        title="Empty and disconnected"
        description="Say what's happening and what to do next."
      >
        <div className="doc-grid">
          <EmptyState
            title="No matches on Table 5 yet"
            action={
              <DemoButton variant="secondary" size="sm">
                Assign a match
              </DemoButton>
            }
          >
            It opens for Round of 16 at about 12:30.
          </EmptyState>
          <div className="fm-matches">
            <MatchRow match={findMatch('d1')} gameScores />
          </div>
        </div>
      </Example>
      <Example
        testId="ex-score-entry-and-game-history"
        title="Score entry and game history"
        description="Large targets for the table side. Each point flashes once. A won game shows a toast with Undo. The history below updates as you score."
      >
        <ScorePad
          style={{ maxWidth: 560 }}
          players={[{ name: 'Patel, Meera' }, { name: 'Wójcik-Szymańska, Agnieszka' }]}
          start={{ games: [[11, 8], [6, 11], [11, 9], [9, 11]], points: [9, 9], serve: 1 }}
          bestOf={5}
        />
      </Example>
      <Example
        testId="ex-schedule-blocks"
        title="Schedule blocks"
        description="Surnames stacked so a 35-minute slot holds the longest names. Full names in the tooltip and accessible name. Selected uses the orange edge."
      >
        <ScheduleBlocks />
      </Example>
      <Example
        testId="ex-rest-indicator"
        title="Rest indicator"
        description="Blue clock and the time rest ends. With a meter where the player is waiting on it."
        stageStyle={{ maxWidth: 360 }}
      >
        <RestIndicator until="12:10" />
        <div className="fm-field">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <RestIndicator until={rest.until} />
            <span className="fm-help num">{restLeft} min left</span>
          </div>
          <Meter label="Rest elapsed" value={rest.length - restLeft} max={rest.length} rest />
        </div>
      </Example>
    </GallerySection>
  )
}
