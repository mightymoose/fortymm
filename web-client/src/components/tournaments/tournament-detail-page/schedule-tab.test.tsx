import { buildEvent, buildPool, buildTournament } from '../data/seed.factory'
import { scheduleTabPage } from './schedule-tab.page'

describe('ScheduleTab', () => {
  it('lists each scheduled pool under its day', () => {
    scheduleTabPage.render({
      tournament: buildTournament({
        events: [
          buildEvent({
            name: 'Open Singles',
            pools: [
              buildPool({
                name: 'Pool A',
                slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
              }),
            ],
          }),
        ],
      }),
    })
    expect(scheduleTabPage.queryText('Open Singles')).toBeInTheDocument()
    expect(scheduleTabPage.queryText('09:00–12:30')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is scheduled', () => {
    scheduleTabPage.render({
      tournament: buildTournament({ events: [buildEvent({ pools: [] })] }),
    })
    expect(scheduleTabPage.queryText('Nothing scheduled')).toBeInTheDocument()
  })
})
