import userEvent from '@testing-library/user-event'

import { buildEvent, buildTournament } from './data/seed.factory'
import { tournamentDetailPagePage } from './tournament-detail-page.page'

describe('TournamentDetailPage', () => {
  it('shows the lifecycle action matching the status', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'draft' }),
    })
    expect(
      tournamentDetailPagePage.getLifecycleButton(/Publish/),
    ).toBeInTheDocument()
    expect(
      tournamentDetailPagePage.queryLifecycleButton(/Start tournament/),
    ).toBeNull()
  })

  it('publishes a draft tournament', async () => {
    const onUpdate = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'draft' }),
      onUpdate,
    })
    await userEvent.click(tournamentDetailPagePage.getLifecycleButton(/Publish/))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published' }),
    )
  })

  it('opens the event editor and creates a new event', async () => {
    const onCreateEvent = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [] }),
      onCreateEvent,
    })

    await userEvent.click(tournamentDetailPagePage.getNewEventButton())
    await userEvent.click(tournamentDetailPagePage.getEditorSaveButton())
    expect(onCreateEvent).toHaveBeenCalledTimes(1)
  })

  it('hides the lifecycle action for a non-creator', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ status: 'draft', canEdit: false }),
    })
    expect(
      tournamentDetailPagePage.queryLifecycleButton(/Publish/),
    ).toBeNull()
  })

  it('hides the "new event" affordance for a non-creator', () => {
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [buildEvent()], canEdit: false }),
    })
    expect(tournamentDetailPagePage.queryNewEventButtons()).toHaveLength(0)
  })

  it('navigates back via the breadcrumb', async () => {
    const onBack = vi.fn()
    tournamentDetailPagePage.render({
      tournament: buildTournament({ events: [buildEvent()] }),
      onBack,
    })
    await userEvent.click(tournamentDetailPagePage.getBackCrumb())
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
