import { buildNotFoundContentProps } from './not-found-content.factory'
import { notFoundContentPage } from './not-found-content.page'

describe('NotFoundContent', () => {
  it('renders the 404 eyebrow, the headline, and the body copy it is given', () => {
    notFoundContentPage.render(
      buildNotFoundContentProps({
        headline: 'Player not found.',
        body: 'No player with that id.',
      }),
    )

    expect(notFoundContentPage.getCode()).toBeInTheDocument()
    expect(notFoundContentPage.getHeadline()).toHaveTextContent(
      'Player not found.',
    )
    expect(
      notFoundContentPage.getBody('No player with that id.'),
    ).toBeInTheDocument()
  })

  it('renders the meta line under its accessible label', () => {
    notFoundContentPage.render({
      meta: { label: 'Requested path', value: '/nope' },
    })

    expect(notFoundContentPage.queryMeta('Requested path')).toHaveTextContent(
      '/nope',
    )
  })

  it('omits the meta line entirely when given no meta', () => {
    notFoundContentPage.render({ meta: undefined })

    expect(notFoundContentPage.queryMeta('Requested path')).toBeNull()
  })

  it('renders exactly one recovery action, pointed where the caller asked', () => {
    notFoundContentPage.render({
      action: <a href="/players">Back to players</a>,
    })

    const actions = notFoundContentPage.getActions()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toHaveAccessibleName('Back to players')
    expect(actions[0]).toHaveAttribute('href', '/players')
  })

  it('renders no <main> landmark of its own, so it can sit inside an app shell', () => {
    notFoundContentPage.render()

    expect(notFoundContentPage.getMainLandmarks()).toHaveLength(0)
  })
})
