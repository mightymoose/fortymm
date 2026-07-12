import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import {
  PlayerRouteError,
  type PlayerRouteErrorProps,
} from './player-route-error'
import { buildPlayerRouteErrorProps } from './player-route-error.factory'

/**
 * The class names the *match list*'s empty state owns. They are declared only
 * under a `.match-list-page` ancestor (`components/matches/match-list/match-list.css`),
 * so on the player routes — which have no such ancestor — they select nothing
 * and paint nothing. This boundary reached for all four until #1001's error half
 * was fixed; `getDeadStyleNodes()` is the pin that stops them coming back.
 */
const MATCH_LIST_ONLY_CLASSES = [
  '.empty',
  '.empty-title',
  '.empty-sub',
  '.empty-clear',
]

const scoped = (container: Container) => ({
  /** The error region. TanStack's router resolves asynchronously, so every test
   * starts here. */
  findAlert() {
    return container.findByRole('alert')
  },
  /** The error region, once it has rendered. */
  getAlert() {
    return container.getByRole('alert')
  },
  /** The mono eyebrow above the headline. Reads "Error" — never "404", which is
   * the *not-found* state's eyebrow and would be a lie about a 500. */
  getEyebrow() {
    return container.getByText('Error')
  },
  /** The display headline, exposed as a level-1 heading. The old markup used a
   * bare `<div class="empty-title">` — no heading at all. */
  getHeadline() {
    return container.getByRole('heading', { level: 1 })
  },
  /** The explanatory sentence beneath the headline. */
  getBody(text: string | RegExp) {
    return container.getByText(text)
  },
  /** The retry affordance — the whole point of the retryable branch. */
  getRetry() {
    return container.getByRole('button', { name: 'Try again' })
  },
  /**
   * **Every** way out of this state: buttons and links alike. #1001's complaint
   * was a boundary whose 4xx branch offered none of either, so tests assert on
   * the count as much as on the target.
   */
  getActions() {
    return [
      ...container.queryAllByRole('button'),
      ...container.queryAllByRole('link'),
    ]
  },
  /**
   * The `<main>` landmarks in scope. This boundary renders **none** — it replaces
   * the route's component *inside* the `_app` layout, which already is an
   * `<AppShell>` with the page's one `<main>`.
   */
  getMainLandmarks() {
    return container.queryAllByRole('main')
  },
})

/**
 * Test page-object for `PlayerRouteError`. The component calls `useRouter()` (the
 * retry invalidates the router), so it mounts under a memory router — hence the
 * async `findAlert()`.
 */
export const playerRouteErrorPage = {
  render(overrides: Partial<PlayerRouteErrorProps> = {}) {
    const props = buildPlayerRouteErrorProps(overrides)
    renderWithRoutes(<PlayerRouteError {...props} />)
  },

  /**
   * The designed page-level error block — `md-error-state`, declared globally in
   * `src/index.css` under `.fortymm-theme` (which is on `<body>`), and shared with
   * `AppError` and the match-details boundary. Present means the state paints with
   * a treatment that actually applies on this route.
   */
  getStyledBlock() {
    return document.querySelector('.md-error-state')
  },

  /**
   * Any node reaching for the match-list-only `.empty*` classes — CSS that exists
   * nowhere near the player routes. Non-empty means the state is painting as naked,
   * unpadded text again (#1001).
   */
  getDeadStyleNodes() {
    return Array.from(
      document.querySelectorAll(MATCH_LIST_ONLY_CLASSES.join(', ')),
    )
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree, for a parent page object that embeds this state.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
