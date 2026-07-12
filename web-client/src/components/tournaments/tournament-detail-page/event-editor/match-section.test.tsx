import userEvent from '@testing-library/user-event'

import { buildEvent } from '../../data/seed.factory'
import { matchSectionPage } from './match-section.page'

describe('MatchSection', () => {
  it('reflects the current rated state', () => {
    matchSectionPage.render({
      event: buildEvent({ match: { rated: false, lengthGames: 3 } }),
    })
    expect(matchSectionPage.getRatedSwitch()).not.toBeChecked()
  })

  it('toggles rated off', async () => {
    const onChange = vi.fn()
    matchSectionPage.render({
      event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
      onChange,
    })
    await userEvent.click(matchSectionPage.getRatedSwitch())
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ match: { rated: false, lengthGames: 5 } }),
    )
  })

  it('changes the best-of length', async () => {
    const onChange = vi.fn()
    matchSectionPage.render({
      event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
      onChange,
    })
    await userEvent.click(matchSectionPage.getLengthOption('Bo7'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ match: { rated: true, lengthGames: 7 } }),
    )
  })

  // The organizer has the toggle, so the copy telling them when to reach for it
  // still earns its place. Asserted so that neutering it for the viewer can't be
  // achieved by deleting the sentence outright (ADR 0015, rule 5).
  it('tells the owner when to turn rating off', () => {
    matchSectionPage.render({ canEdit: true })
    expect(matchSectionPage.getRatedDescription()).toHaveTextContent(
      'Results count toward player ratings. Turn off for casual events.',
    )
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015). The `radio` sweep in `getFormElements` is what
    // catches the length picker — the four canonical roles do not cover it.
    it('renders no interactive controls', () => {
      matchSectionPage.render({ event: buildEvent(), canEdit: false })
      expect(matchSectionPage.getInteractiveControls()).toHaveLength(0)
      expect(matchSectionPage.getFormElements()).toHaveLength(0)
    })

    // A dead toggle says nothing; prose says whether the event is rated.
    it('renders the rated state as prose', () => {
      matchSectionPage.render({
        event: buildEvent({ match: { rated: true, lengthGames: 5 } }),
        canEdit: false,
      })
      expect(matchSectionPage.getRatedValue()).toHaveTextContent('Rated')
    })

    it('renders an unrated event as prose', () => {
      matchSectionPage.render({
        event: buildEvent({ match: { rated: false, lengthGames: 3 } }),
        canEdit: false,
      })
      expect(matchSectionPage.getRatedValue()).toHaveTextContent('Not rated')
    })

    // "Turn off for casual events" instructs a reader who has no toggle to turn
    // off — the organizer's voice leaking into the viewer's screen. The
    // descriptive half stays: it still tells them what "Rated" means here.
    it('drops the imperative from the rated description, keeping the description', () => {
      matchSectionPage.render({ canEdit: false })
      const description = matchSectionPage.getRatedDescription()
      expect(description).toHaveTextContent('Results count toward player ratings.')
      expect(description).not.toHaveTextContent('Turn off for casual events')
    })

    it('renders the match length as its label', () => {
      matchSectionPage.render({
        event: buildEvent({ match: { rated: true, lengthGames: 7 } }),
        canEdit: false,
      })
      expect(matchSectionPage.getLengthValue()).toHaveTextContent('Bo7')
    })
  })
})
