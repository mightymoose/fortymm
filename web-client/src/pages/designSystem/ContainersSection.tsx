import { useRef, useState, type Ref } from 'react'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { closeDialog } from '../../components/closeDialog'
import { DetailList } from '../../components/DetailList'
import { Dialog } from '../../components/Dialog'
import { ScrollArea } from '../../components/ScrollArea'
import { SplitView } from '../../components/SplitView'
import { useToast } from '../../components/toastContext'
import { DemoButton } from './DemoButton'
import { Example, GallerySection } from './GallerySection'
import { day, findMatch, type Match } from './match'
import { MatchDetail } from './MatchDetail'
import { MatchRow } from './MatchRow'
import { MatchStatus } from './MatchStatus'
import { Timeline } from './Timeline'
import { scoringScreenUrl, tournamentScreenUrl } from './referenceLinks'

// The match on Table 3, which the Card example's first card is about.
const tableMatch = findMatch('c2')

// The check-in list's players, in the gallery's order. The first nine are
// checked in to start with.
const checkInPlayers = [
  'Nguyen, Thanh',
  'Okafor-Adeyemi, Daniel',
  'Johansen-Whitfield, Annika',
  'Patel, Meera',
  'Park, Ji-ho',
  'Wójcik-Szymańska, Agnieszka',
  'Chen, Wei',
  'Ali, Rashid',
  'Moreau, Élodie',
  'Kim, Hyun-woo',
  'Lindqvist, Erik',
  'Fernández-Castillo, Marisol',
]

// The dialog that the split view's "Withdraw a player…" opens.
function WithdrawPlayerDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  return (
    <Dialog
      ref={ref}
      title="Withdraw a player from this match?"
      actions={
        <>
          <Button variant="secondary" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="danger-solid" onClick={closeDialog}>
            Withdraw
          </Button>
        </>
      }
    >
      <p>Their opponent advances. Both players are told straight away.</p>
    </Dialog>
  )
}

// The Scroll area example: a check-in list that scrolls inside its card.
// "Check in all" checks everyone in, and Undo puts the boxes back as they
// were.
function CheckInCard() {
  const showToast = useToast()
  const [checked, setChecked] = useState(() => checkInPlayers.map((_, index) => index < 9))

  function checkInAll() {
    const before = checked
    const added = before.filter((here) => !here).length
    setChecked(before.map(() => true))
    showToast(
      added ? `${added} more players checked in` : 'Everyone was already checked in',
      { undo: added ? () => setChecked(before) : undefined },
    )
  }

  return (
    <Card
      title="Check-in"
      subtitle="12 of 16 players here"
      status={
        <Button variant="secondary" size="sm" onClick={checkInAll}>
          Check in all
        </Button>
      }
      style={{ maxWidth: 520 }}
      bodyStyle={{ paddingTop: 8 }}
    >
      <ScrollArea label="Players" heading="Player" style={{ maxHeight: 236 }}>
        <ul className="fm-list" style={{ paddingRight: 8 }}>
          {checkInPlayers.map((name, index) => (
            <li key={name}>
              <label className="fm-check" style={{ width: '100%' }}>
                <input
                  type="checkbox"
                  checked={checked[index]}
                  onChange={(event) =>
                    setChecked(checked.with(index, event.currentTarget.checked))
                  }
                />
                {name}
              </label>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Card>
  )
}

// The Split view example: the day's schedule beside the details of the
// match picked in it, Patel vs Park to start with.
function ScheduleSplit({ onWithdraw }: { onWithdraw: () => void }) {
  const [shown, setShown] = useState<Match>(() => findMatch('b3'))
  return (
    <SplitView
      label="Resize schedule and match details"
      start={
        <div style={{ minWidth: 0 }}>
          <ScrollArea label="Schedule timeline" style={{ paddingBottom: 8 }}>
            <Timeline day={day} initial="b3" onSelect={setShown} />
          </ScrollArea>
        </div>
      }
      end={
        <div aria-live="polite">
          <MatchDetail key={shown.id} match={shown} onWithdraw={onWithdraw} />
        </div>
      }
    />
  )
}

// The design system page's Containers section: the reference gallery's
// `section-containers`, with its Card, Scroll area and Split view examples.
export function ContainersSection() {
  const withdrawPlayerDialog = useRef<HTMLDialogElement>(null)
  return (
    <GallerySection
      id="containers"
      title="Containers"
      lead="Enclose only when it marks a real boundary. Inside a card, whitespace and alignment do the grouping."
    >
      <Example
        testId="ex-card"
        title="Card"
        description="Persistent information: a title row with status at the right, grouped details, actions at the bottom left with the primary first. No border — the lighter surface is the edge."
      >
        <div className="doc-grid">
          <Card
            title="Table 3"
            subtitle="Open singles · Round of 32"
            status={<MatchStatus match={tableMatch} />}
            actions={
              <>
                <a className="fm-btn fm-btn--secondary" href={scoringScreenUrl}>
                  Open scoring
                </a>
                <DemoButton variant="ghost">Move table</DemoButton>
              </>
            }
          >
            <MatchRow match={tableMatch} headHidden gameScores />
          </Card>
          <Card
            title="Wójcik-Szymańska, Agnieszka"
            subtitle="Northside · seed 3"
            actions={
              <>
                <DemoButton variant="secondary">View matches</DemoButton>
                <DemoButton variant="ghost">Message</DemoButton>
              </>
            }
          >
            <DetailList
              details={[
                { term: 'Rating', value: '2,088', numeric: true },
                { term: 'Today', value: 'Won 2, lost 0' },
                { term: 'Next', value: '12:40 · Table 1' },
                { term: 'Events', value: 'Open singles, Open doubles' },
              ]}
            />
          </Card>
        </div>
      </Example>
      <Example
        testId="ex-scroll-area"
        title="Scroll area"
        description="Lives inside its card — no extra frame. The column heading sticks; the scrollbar is the only extra chrome. Focusable so keyboard users can scroll it."
      >
        <CheckInCard />
      </Example>
      <Example
        testId="ex-split-view"
        title="Split view"
        style={{ gridTemplateColumns: 'minmax(0,1fr)' }}
        headerStyle={{ maxWidth: 640 }}
        description={
          <>
            Schedule beside match details. Actions in the details panel work on the{' '}
            <a href={tournamentScreenUrl}>tournament screen</a>; here they only say so. Panes
            are separated by space; the handle is the one drawn element. Drag it or focus it
            and use ← →. Stacks below 900px. Click any block.
          </>
        }
      >
        <ScheduleSplit onWithdraw={() => withdrawPlayerDialog.current?.showModal()} />
      </Example>
      <WithdrawPlayerDialog ref={withdrawPlayerDialog} />
    </GallerySection>
  )
}
