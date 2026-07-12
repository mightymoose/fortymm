import userEvent from '@testing-library/user-event'

import {
  PLAYERS_LIST_PATH,
  playerNotFoundPage,
} from './player-not-found.page'

describe('PlayerNotFound', () => {
  it('names the missing thing — a player, not a page', async () => {
    playerNotFoundPage.render()

    expect(await playerNotFoundPage.findHeadline()).toHaveTextContent(
      'Player not found.',
    )
    expect(
      playerNotFoundPage.getBody(/no player with that id/i),
    ).toBeInTheDocument()
  })

  it('offers exactly one recovery action, and it points at the players list', async () => {
    // The bug this state was designed for (#1001): the 4xx branch of the old
    // error boundary rendered *no* action at all — enumerating the links and
    // buttons in `main` returned `[]` and the only escape was the back button.
    // So assert on the navigable link, not on the presence of some text.
    playerNotFoundPage.render()
    await playerNotFoundPage.findHeadline()

    const actions = playerNotFoundPage.getActions()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toHaveAccessibleName('Back to players')
    expect(actions[0]).toHaveAttribute('href', PLAYERS_LIST_PATH)
  })

  it('lands the user on the players list when the action is followed', async () => {
    const user = userEvent.setup()
    playerNotFoundPage.render()
    await playerNotFoundPage.findHeadline()

    await user.click(playerNotFoundPage.getActions()[0])

    expect(await playerNotFoundPage.findPlayersList()).toBeInTheDocument()
  })

  it('renders no <main> landmark of its own — the route already sits inside one', async () => {
    // The double-shell guard, and the reason this renders `NotFoundContent`
    // rather than reusing `NotFoundPage`: the player routes live under `_app`,
    // which *is* an `<AppShell>`. Wiring a shell-wrapping 404 as their
    // `notFoundComponent` would give the page two <main> landmarks, two
    // sidebars and two headers. If this goes red, someone added a shell.
    playerNotFoundPage.render()
    await playerNotFoundPage.findHeadline()

    expect(playerNotFoundPage.getMainLandmarks()).toHaveLength(0)
  })

  it('does not echo the requested path — the id is not the recovery here', async () => {
    // Deliberately unlike the root 404, which *does* echo the pathname: there
    // the URL matched nothing, so the path is the evidence. Here the route
    // matched and only the id is unknown.
    playerNotFoundPage.render()
    await playerNotFoundPage.findHeadline()

    expect(playerNotFoundPage.queryMeta('Requested path')).toBeNull()
  })
})
