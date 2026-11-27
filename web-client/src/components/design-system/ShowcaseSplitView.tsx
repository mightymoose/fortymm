import { type ComponentProps } from 'react'
import { Alert } from '../../design-system/Alert.tsx'
import { Button } from '../../design-system/Button.tsx'
import { Card } from '../../design-system/Card.tsx'
import { DescriptionList } from '../../design-system/DescriptionList.tsx'
import { MatchRow } from '../../design-system/MatchRow.tsx'
import { ScheduleBlock } from '../../design-system/ScheduleBlock.tsx'
import { ScrollArea } from '../../design-system/ScrollArea.tsx'
import { SplitView } from '../../design-system/SplitView.tsx'
import { StatusMarker } from '../../design-system/StatusMarker.tsx'
import { Timeline } from '../../design-system/Timeline.tsx'
import { TimelineTrack } from '../../design-system/TimelineTrack.tsx'

type Block = ComponentProps<typeof ScheduleBlock>

// The Containers board's schedule, 10:30 to 13:00, now fixed at 11:47, copied from the board: each
// table's blocks, in minutes from 10:30. The conflict on Table 2 is selected.
const schedule: [string, Block[]][] = [
  [
    'Table 1',
    [
      {
        state: 'final',
        score: '3–1',
        names: ['Nguyen', 'Silva'],
        time: '10:30–11:05',
        description: 'Nguyen, Thanh vs Silva, Rafael · Table 1 · 10:30–11:05',
        start: 0,
        length: 35,
      },
      {
        state: 'live',
        names: ['Okafor-Adeyemi', 'Johansen-Whitfield'],
        time: 'since 11:10',
        description:
          'Okafor-Adeyemi, Daniel vs Johansen-Whitfield, Annika · Table 1 · since 11:10',
        start: 40,
        length: 35,
      },
      {
        state: 'upcoming',
        names: ['Chen', 'Ali'],
        time: '12:00–12:35',
        description: 'Chen, Wei vs Ali, Rashid · Table 1 · 12:00–12:35',
        start: 90,
        length: 35,
      },
    ],
  ],
  [
    'Table 2',
    [
      {
        state: 'final',
        score: '3–0',
        names: ['Lindqvist', 'Haddad'],
        time: '10:30–11:00',
        description: 'Lindqvist, Erik vs Haddad, Youssef · Table 2 · 10:30–11:00',
        start: 0,
        length: 30,
      },
      { state: 'free', time: '11:05–11:45', start: 35, length: 40 },
      {
        state: 'conflict',
        names: ['Patel', 'Park'],
        time: '11:50–12:25',
        description: 'Patel, Meera vs Park, Ji-ho · Table 2 · 11:50–12:25 · Patel would rest 5 min',
        isSelected: true,
        start: 80,
        length: 35,
      },
    ],
  ],
  [
    'Table 3',
    [
      {
        state: 'final',
        score: '3–2',
        names: ['Moreau', 'Kim'],
        time: '10:30–11:05',
        description: 'Moreau, Élodie vs Kim, Hyun-woo · Table 3 · 10:30–11:05',
        start: 0,
        length: 35,
      },
      {
        state: 'live',
        names: ['Patel', 'Wójcik-Szymańska'],
        time: 'since 11:05',
        description: 'Patel, Meera vs Wójcik-Szymańska, Agnieszka · Table 3 · since 11:05',
        start: 35,
        length: 40,
      },
      {
        state: 'upcoming',
        rest: { player: 'Lindqvist', until: '12:10' },
        names: ['Dubois', 'Lindqvist'],
        time: '12:15–12:50',
        description: 'Dubois, Camille vs Lindqvist, Erik · Table 3 · 12:15–12:50',
        start: 105,
        length: 35,
      },
    ],
  ],
  [
    'Table 4',
    [
      {
        state: 'offline',
        names: ['Rossi / Haddad', 'Fernández-Castillo / Kim'],
        time: 'since 11:00',
        description:
          'Rossi, Giulia / Haddad, Youssef vs Fernández-Castillo, Marisol / Kim, Hyun-woo · Table 4 · since 11:00',
        start: 30,
        length: 40,
      },
      {
        state: 'upcoming',
        names: ['Moreau', 'Silva'],
        time: '12:05–12:40',
        description: 'Moreau, Élodie vs Silva, Rafael · Table 4 · 12:05–12:40',
        start: 95,
        length: 35,
      },
    ],
  ],
]

const marks = [
  { at: 0, label: '10:30' },
  { at: 30, label: '11:00' },
  { at: 60, label: '11:30' },
  { at: 90, label: '12:00' },
  { at: 120, label: '12:30' },
]

// The Containers board's split view: the schedule beside the selected match's details. As on the
// board, its blocks and buttons do nothing when pressed; the handle does resize the panes.
export function ShowcaseSplitView() {
  return (
    <SplitView
      label="Resize schedule and match details"
      defaultValue={66}
      minValue={35}
      maxValue={72}
      start={
        <ScrollArea label="Schedule timeline" isHorizontal>
          <Timeline
            label="Schedule, 10:30 to 13:00"
            length={150}
            marks={marks}
            now={{ at: 77, label: 'Now 11:47' }}
          >
            {schedule.map(([table, blocks]) => (
              <TimelineTrack key={table} name={table}>
                {blocks.map((block) => (
                  <ScheduleBlock key={block.start} {...block} />
                ))}
              </TimelineTrack>
            ))}
          </Timeline>
        </ScrollArea>
      }
      end={
        <Card
          title="Patel vs Park"
          subtitle="Open singles · Round of 16"
          status={<StatusMarker tone="conflict">Needs decision</StatusMarker>}
          footer={
            <>
              <Button variant="primary">Call to table</Button>
              <Button variant="ghost">Reschedule</Button>
              <Button variant="danger" className="end">
                Withdraw a player…
              </Button>
            </>
          }
        >
          <MatchRow
            state="conflict"
            size="lg"
            players={[
              { name: 'Patel, Meera', club: 'Riverside TT' },
              { name: 'Park, Ji-ho', club: 'Eastgate' },
            ]}
          />
          <Alert
            tone="warning"
            label="Scheduling conflict"
            title="Patel would get 5 minutes’ rest"
            actions={
              <>
                <Button variant="primary" size="sm">
                  Move to 12:05
                </Button>
                <Button variant="secondary" size="sm">
                  Keep 11:50
                </Button>
              </>
            }
          >
            Her match on Table 3 is running 10 minutes over. Starting at 12:05 keeps the 15-minute
            minimum.
          </Alert>
          <DescriptionList
            items={[
              { term: 'Event', details: 'Open singles' },
              { term: 'Round', details: 'Round of 16' },
              { term: 'Table', details: 'Table 2' },
              { term: 'Start', details: '11:50' },
            ]}
          />
        </Card>
      }
    />
  )
}
