import type { ReactNode } from 'react'
import { Alert } from './Alert.tsx'
import { Avatar } from './Avatar.tsx'
import { Board, BoardGrid, BoardSection, Spec, Stage } from './Board.tsx'
import { Breadcrumbs } from './feedback-tab/Breadcrumbs.tsx'
import { Button } from './Button.tsx'
import { Card } from './feedback-tab/Card.tsx'
import { DataTable } from './feedback-tab/DataTable.tsx'
import { DescriptionList } from './feedback-tab/DescriptionList.tsx'
import { Dialog } from './Dialog.tsx'
import { Disclosure } from './feedback-tab/Disclosure.tsx'
import { EmptyState } from './EmptyState.tsx'
import { Kbd } from './feedback-tab/Kbd.tsx'
import { LiveMarker } from './LiveMarker.tsx'
import { Menu } from './feedback-tab/Menu.tsx'
import { Meter } from './feedback-tab/Meter.tsx'
import { Nav } from './feedback-tab/Nav.tsx'
import { Notice } from './feedback-tab/Notice.tsx'
import { Pagination } from './feedback-tab/Pagination.tsx'
import { RatingChange } from './RatingChange.tsx'
import { Skeleton } from './feedback-tab/Skeleton.tsx'
import { Tag } from './feedback-tab/Tag.tsx'
import { Toast } from './feedback-tab/Toast.tsx'
import { Tooltip } from './feedback-tab/Tooltip.tsx'
import { UpdateNotice } from './UpdateNotice.tsx'
import './FeedbackTab.css'

// The design system page's Feedback tab (/design-system/feedback): the
// containers, feedback and overlays, as the reference sheet's "Containers,
// feedback, overlays" board (references/design-system/Feedback.dc.html),
// with its data-testids. Overlays (toast, tooltip, menu, dialog) are drawn
// in place, as the board draws them, so they show without being opened.
export function FeedbackTab() {
  return (
    <Board
      id="feedback"
      title="Feedback"
      intro="Each role has its own structure: card for persistent info, notice for a sentence in the flow, alert for a problem with a fix, toast for brief success, tooltip for supplementary text. Overlays are drawn in place, so they show without opening."
    >
      <BoardSection
        id="feedback-card"
        testId="section-card"
        title="Card"
        description={
          <>
            <code>--bg-panel</code>, no border. Title and status top-right,
            label/value details, actions bottom-left with the primary first.
          </>
        }
      >
        <BoardGrid columns={2}>
          <Spec title="Card" detail="head · DescriptionList · foot">
            <Stage testId="role-card" layout="block">
              <Card
                title="Nguyen, Thanh vs Okafor, Daniel"
                subtitle="Open singles · Round of 16"
                headingLevel={4}
                status={<LiveMarker />}
                actions={
                  <>
                    <Button variant="primary">Enter score</Button>
                    <Button variant="secondary">Move table</Button>
                  </>
                }
              >
                <DescriptionList
                  items={[
                    { term: 'Table', detail: '3' },
                    { term: 'Started', detail: '11:20', numeric: true },
                    { term: 'Games', detail: '2–1', numeric: true },
                    { term: 'Umpire', detail: 'Park, Ji-ho' },
                  ]}
                />
              </Card>
            </Stage>
          </Spec>
          <Spec title="Notice" detail="info · rest · success · warning">
            <Stage
              testId="role-notice-examples"
              layout="column"
              className="notice-stage"
            >
              {target(
                'notice-default',
                <Notice>
                  Draws are published at <b>9:30</b>. You can still swap
                  partners until then.
                </Notice>,
              )}
              {target(
                'notice-rest',
                <Notice tone="rest">
                  Okafor is resting until <b>19:35</b>.
                </Notice>,
              )}
              {target(
                'notice-success',
                <Notice tone="success">All 24 players checked in.</Notice>,
              )}
              {target(
                'notice-warning',
                <Notice tone="warning">
                  Two matches are running late on Table 2.
                </Notice>,
              )}
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="feedback-alerts"
        testId="section-alerts"
        title="Warning and error"
        description="Tinted fill and full hue edge. Title is the problem, body is why, buttons are the fix."
      >
        <BoardGrid columns={2}>
          <Spec title="Alert warning" detail="--conflict">
            <Stage testId="role-warning" layout="block">
              <Alert
                tone="warning"
                title="Okafor's singles is 15 min over on Table 2"
                actions={
                  <>
                    <Button variant="secondary" size="sm">
                      Move doubles to 13:05
                    </Button>
                    <Button variant="ghost" size="sm">
                      Keep as is
                    </Button>
                  </>
                }
              >
                His doubles at 12:50 would start without the 10 min rest.
              </Alert>
            </Stage>
          </Spec>
          <Spec title="Alert error" detail="--danger · role=alert">
            <Stage testId="role-error" layout="block">
              <Alert
                tone="error"
                title="Table 4's tablet stopped sending scores"
                actions={
                  <Button variant="secondary" size="sm">
                    Enter score here
                  </Button>
                }
              >
                The last update was at 11:42. Scores entered there are kept on
                the tablet.
              </Alert>
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="feedback-overlays"
        testId="section-overlays"
        title="Toast, tooltip, menu, dialog"
        description="The only things with a shadow. Drawn in place here, as they look when open."
      >
        <BoardGrid columns={2}>
          <Spec title="Toast" detail="success only · 6 s">
            <Stage testId="role-toast" layout="center" className="overlay-stage">
              <Toast message="Match saved. Rating +12." action="Undo" />
            </Stage>
          </Spec>
          <Spec title="Tooltip" detail="wraps at 280px">
            <Stage
              testId="role-tooltip"
              layout="center"
              className="overlay-stage tooltip-stage"
            >
              <Tooltip id="feedback-tooltip">
                Nguyen, Thanh (Riverside TT) vs Okafor, Daniel (Northside)
              </Tooltip>
              <Button
                variant="secondary"
                size="sm"
                aria-describedby="feedback-tooltip"
              >
                Okafor · Nguyen
              </Button>
            </Stage>
          </Spec>
          <Spec title="Menu" detail="first item hovered">
            <Stage testId="ex-menu" layout="center" className="overlay-stage">
              <Menu
                label="Match actions"
                items={[
                  {
                    label: 'Call to table',
                    shortcut: 'C',
                    forcedState: 'hover',
                  },
                  { label: 'Move to another table', shortcut: 'M' },
                  { label: 'Print score sheet', shortcut: 'P' },
                  'separator',
                  { label: 'Withdraw player…', danger: true },
                ]}
              />
            </Stage>
          </Spec>
          <Spec title="Dialog" detail="static, no backdrop">
            <Stage testId="ex-dialog" layout="center" className="overlay-stage">
              <Dialog
                title="Withdraw Okafor from Open singles?"
                actions={
                  <>
                    <Button variant="ghost">Cancel</Button>
                    <Button variant="danger">Withdraw</Button>
                  </>
                }
              >
                His remaining matches go to his opponents as walkovers. You
                can add him back until the draw closes.
              </Dialog>
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="feedback-data"
        testId="section-data"
        title="Tags, avatars, table, progress"
        description="Flat surfaces, numbers in mono with tabular figures."
      >
        <BoardGrid columns={3}>
          <Spec title="Tag" detail="filled · outline">
            <Stage testId="ex-tags">
              <Tag>Open singles</Tag>
              <Tag>U-2000</Tag>
              <Tag outline>Seeded 3</Tag>
              <Tag outline>Doubles</Tag>
            </Stage>
          </Spec>
          <Spec title="Avatar" detail="flat initials">
            <Stage testId="ex-avatars">
              <Avatar initials="TN" />
              <Avatar initials="DO" />
              <Avatar initials="JP" />
              <Avatar initials="AK" size="sm" />
            </Stage>
          </Spec>
          <Spec title="Meter · Skeleton" detail="default · rest · static">
            <Stage testId="ex-meters" layout="column" className="meter-stage">
              <Meter value={62} label="62% of matches played" />
              <Meter value={40} label="Rest 40% done" rest />
              <Skeleton width="70%" height="14px" />
            </Stage>
          </Spec>
        </BoardGrid>
        <div className="data-grid">
          <BoardGrid columns={2}>
            <Spec title="DataTable" detail="numeric = mono, right-aligned">
              <Stage testId="ex-data-table" layout="block" panel>
                <DataTable
                  label="Ratings"
                  columns={[
                    { key: 'player', label: 'Player' },
                    { key: 'club', label: 'Club' },
                    { key: 'rating', label: 'Rating', numeric: true },
                    { key: 'change', label: 'Change', numeric: true },
                  ]}
                  rows={[
                    rating('Nguyen, Thanh', 'Riverside TT', '2,145', 12),
                    rating('Okafor, Daniel', 'Northside', '2,098', -8),
                    rating('Park, Ji-ho', 'Riverside TT', '1,987', 4),
                  ]}
                />
              </Stage>
            </Spec>
            <Spec title="Disclosure" detail="open · closed">
              <Stage
                testId="ex-accordion"
                layout="column"
                className="accordion-stage"
              >
                <Disclosure summary="Scheduling details" defaultOpen>
                  Rest between matches is at least 10 minutes. Doubles never
                  overlap a player's singles.
                </Disclosure>
                <Disclosure summary="Entry fees">Free.</Disclosure>
              </Stage>
            </Spec>
          </BoardGrid>
        </div>
      </BoardSection>

      <BoardSection
        id="feedback-navigation"
        testId="section-navigation"
        title="Navigation and empty state"
        description={
          <>
            Current page uses <code>--accent-soft</code> with{' '}
            <code>--accent-text</code>.
          </>
        }
      >
        <BoardGrid columns={3}>
          <Spec title="Nav" detail="aria-current">
            <Stage testId="ex-navigation">
              <Nav
                label="Tournament"
                items={[
                  { label: 'Overview', href: '#overview', current: true },
                  { label: 'Schedule', href: '#schedule' },
                  { label: 'Draws', href: '#draws' },
                  { label: 'Players', href: '#players' },
                ]}
              />
            </Stage>
          </Spec>
          <Spec title="Breadcrumbs · Pagination" detail="page 2 current">
            <Stage
              testId="ex-crumbs-pages"
              layout="column"
              className="crumbs-stage"
            >
              <Breadcrumbs
                trail={[
                  { label: 'Spring Open', href: '#spring-open' },
                  { label: 'Open singles', href: '#open-singles' },
                ]}
                current="Round of 16"
              />
              <Pagination label="Results pages" pages={4} defaultPage={2} />
            </Stage>
          </Spec>
          <Spec
            title="EmptyState"
            detail={
              <>
                with <Kbd>N</Kbd> shortcut
              </>
            }
          >
            <Stage testId="ex-empty" layout="block" className="empty-stage">
              <EmptyState
                title="No matches yet."
                action={
                  <Button variant="secondary" size="sm">
                    Log a match
                  </Button>
                }
              >
                Log one after you play.
              </EmptyState>
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="feedback-update-notice"
        testId="section-update-notice"
        title="Update notice"
        description="Not on the reference sheet: the app’s own, built as the toast is. Over every screen, bottom centre, until it is answered. Drawn in place here."
      >
        <BoardGrid columns={2}>
          <Spec title="Update notice" detail="no timer · grey icon">
            <Stage
              testId="role-update-notice"
              layout="center"
              className="overlay-stage"
            >
              <UpdateNotice shown onReload={() => {}} onDismiss={() => {}} />
            </Stage>
          </Spec>
        </BoardGrid>
      </BoardSection>
    </Board>
  )
}

// An example inside a stage with a target of its own.
function target(testId: string, example: ReactNode) {
  return <div data-testid={testId}>{example}</div>
}

// One row of the ratings table.
function rating(player: string, club: string, value: string, change: number) {
  return {
    id: player,
    cells: {
      player,
      club,
      rating: value,
      change: <RatingChange change={change} />,
    },
  }
}
