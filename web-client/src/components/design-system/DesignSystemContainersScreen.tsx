import { Alert } from '../../design-system/Alert.tsx'
import { Button } from '../../design-system/Button.tsx'
import { ButtonLink } from '../../design-system/ButtonLink.tsx'
import { Card } from '../../design-system/Card.tsx'
import { Checkbox } from '../../design-system/Checkbox.tsx'
import { DescriptionList } from '../../design-system/DescriptionList.tsx'
import { LiveMarker } from '../../design-system/LiveMarker.tsx'
import { MatchRow } from '../../design-system/MatchRow.tsx'
import { Notice } from '../../design-system/Notice.tsx'
import { RestMarker } from '../../design-system/RestMarker.tsx'
import { ScrollArea } from '../../design-system/ScrollArea.tsx'
import { StatusMarker } from '../../design-system/StatusMarker.tsx'
import { Toast } from '../../design-system/Toast.tsx'
import './showcase.css'
import { ShowcaseExample } from './ShowcaseExample.tsx'
import { ShowcaseSplitView } from './ShowcaseSplitView.tsx'

// Toasts and the match on the board have their Dismiss and Game scores buttons, but, like every
// button here, they do nothing.
function ignore() {}

// The check-in list in the scroll area: each player, and whether they have checked in.
const checkIn: [string, boolean][] = [
  ['Nguyen, Thanh', true],
  ['Okafor-Adeyemi, Daniel', true],
  ['Johansen-Whitfield, Annika', true],
  ['Patel, Meera', true],
  ['Park, Ji-ho', true],
  ['Wójcik-Szymańska, Agnieszka', true],
  ['Chen, Wei', true],
  ['Ali, Rashid', true],
  ['Moreau, Élodie', true],
  ['Kim, Hyun-woo', false],
  ['Lindqvist, Erik', false],
  ['Fernández-Castillo, Marisol', false],
]

// The design system's Containers board (requirements/design-system/reference/Containers.dc.html):
// containers, and feedback. Text is copied from the board. As on the board, the buttons do nothing
// when pressed.
export function DesignSystemContainersScreen() {
  return (
    <main className="doc" data-testid="page-containers">
      <section className="doc-cat" data-testid="section-containers">
        <h2>Containers</h2>
        <p>
          Enclose only when it marks a real boundary. Inside a card, whitespace and alignment do the
          grouping.
        </p>
        <ShowcaseExample
          testId="ex-card"
          title="Card"
          description="Persistent information: a title row with status at the right, grouped details, actions at the bottom left with the primary first. No border — the lighter surface is the edge."
        >
          <div className="doc-grid2">
            <Card
              title="Table 3"
              subtitle="Open singles · Round of 32"
              status={<LiveMarker />}
              footer={
                <>
                  <ButtonLink variant="secondary" to="/design-system/match">
                    Open scoring
                  </ButtonLink>
                  <Button variant="ghost">Move table</Button>
                </>
              }
            >
              <MatchRow
                state="live"
                players={[
                  { name: 'Patel, Meera', games: 2, points: 9 },
                  { name: 'Wójcik-Szymańska, Agnieszka', games: 2, points: 9, isServing: true },
                ]}
                onGameScoresToggle={ignore}
              />
            </Card>
            <Card
              title="Wójcik-Szymańska, Agnieszka"
              subtitle="Northside · seed 3"
              footer={
                <>
                  <Button variant="secondary">View matches</Button>
                  <Button variant="ghost">Message</Button>
                </>
              }
            >
              <DescriptionList
                items={[
                  { term: 'Rating', details: '2,088', isNumeric: true },
                  { term: 'Today', details: 'Won 2, lost 0' },
                  { term: 'Next', details: '12:40 · Table 1' },
                  { term: 'Events', details: 'Open singles, Open doubles' },
                ]}
              />
            </Card>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-scroll-area"
          title="Scroll area"
          description="Lives inside its card — no extra frame. The column heading sticks; the scrollbar is the only extra chrome."
        >
          <div style={{ maxWidth: 520 }}>
            <Card
              title="Check-in"
              subtitle="12 of 16 players here"
              status={
                <Button variant="secondary" size="sm">
                  Check in all
                </Button>
              }
              isBodyTight
            >
              <ScrollArea label="Players" header="Player" maxHeight={236}>
                <ul className="fm-list" style={{ paddingRight: 8 }}>
                  {checkIn.map(([name, isCheckedIn]) => (
                    <li key={name}>
                      <Checkbox defaultSelected={isCheckedIn}>{name}</Checkbox>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </Card>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-split-view"
          title="Split view"
          description="Schedule beside match details, with the conflict on Table 2 selected. Panes are separated by space; the handle is the one drawn element. Now is fixed at 11:47."
          isWide
        >
          <ShowcaseSplitView />
        </ShowcaseExample>
      </section>
      <section className="doc-cat" data-testid="section-feedback">
        <h2>Feedback</h2>
        <p>Match the weight of the message to what you need to do about it.</p>
        <ShowcaseExample
          testId="ex-toast"
          title="Toast"
          description="Confirms something you just did. Compact, raised, bottom centre. Undo when the action can be reversed. Leaves after 6 s; never for errors."
        >
          <Toast actionLabel="Undo" onDismiss={ignore}>
            Chen vs Ali called to Table 1
          </Toast>
          <Toast onDismiss={ignore}>Table 4 marked free</Toast>
          <Toast tone="info">Works on the tournament screen, not in this gallery</Toast>
          <p className="doc-vo">Visual only</p>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-inline-notice"
          title="Inline notice"
          description="A sentence with an icon, inside the content it's about. No box. Use for rest times, timing info and quiet confirmations."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
            <Notice tone="rest">
              <b>Lindqvist rests until 12:10.</b> Table 3 can start after that.
            </Notice>
            <Notice>Scores update live for spectators; ratings update when a result is saved.</Notice>
            <Notice tone="success">Schedule updated. Expected finish 18:45.</Notice>
            <Notice tone="warning">
              Kept at 11:50 by the organizer. Patel gets 5 minutes’ rest, under the 15-minute
              minimum.
            </Notice>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-warning-and-error"
          title="Warning and error"
          description={
            <>
              The title says what's wrong, the body why, the buttons fix it. They stay until
              resolved. Errors use <code>role="alert"</code>; warnings don't interrupt.
            </>
          }
          stageStyle={{ maxWidth: 620 }}
        >
          <Alert
            tone="warning"
            title="Okafor-Adeyemi is booked on two tables at 12:00"
            actions={
              <>
                <Button variant="primary" size="sm">
                  Move doubles to 12:40
                </Button>
                <Button variant="secondary" size="sm">
                  Choose another time
                </Button>
              </>
            }
          >
            His doubles on Table 4 overlaps his singles on Table 1.
          </Alert>
          <Alert
            tone="error"
            icon="wifi-off"
            title="Table 4 scorer is offline"
            actions={
              <>
                <Button variant="primary" size="sm">
                  Score from this device
                </Button>
                <Button variant="secondary" size="sm" isPending>
                  Sending…
                </Button>
              </>
            }
          >
            Last score arrived at 11:42. Points entered on that device will sync when it reconnects.
          </Alert>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-status-set"
          title="Status set"
          description="Reviewed together so no two read alike. Each has its own hue, a non-colour cue and a place it belongs."
        >
          <div className="doc-status">
            <div>
              <LiveMarker />
              <h4>Live</h4>
              <p>Red dot + word. Static. One per match, never on the border.</p>
            </div>
            <div>
              <StatusMarker tone="danger">Didn't sync</StatusMarker>
              <h4>Error</h4>
              <p>Something failed. Red icon + sentence + recovery action. Persists.</p>
            </div>
            <div>
              <Button variant="danger" size="sm">
                Withdraw…
              </Button>
              <h4>Destructive</h4>
              <p>Red outline on the action only. Always confirmed in a dialog.</p>
            </div>
            <div>
              <RestMarker until="12:10" />
              <h4>Rest</h4>
              <p>Blue clock + the end time. Information, not a problem.</p>
            </div>
            <div>
              <StatusMarker tone="conflict">Needs decision</StatusMarker>
              <h4>Conflict</h4>
              <p>Amber triangle. Organizer screens, always with a suggested fix.</p>
            </div>
            <div>
              <StatusMarker tone="offline">Scorer offline</StatusMarker>
              <h4>Disconnected</h4>
              <p>Hollow grey dot. Scores shown greyed with the last update time.</p>
            </div>
          </div>
        </ShowcaseExample>
      </section>
    </main>
  )
}
