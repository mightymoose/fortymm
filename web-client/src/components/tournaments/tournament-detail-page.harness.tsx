import { useState } from 'react'

import {
  TournamentDetailPage,
  type TournamentDetailPageProps,
} from './tournament-detail-page'
import { buildTournamentDetailPageProps } from './tournament-detail-page.factory'

/**
 * The route's `?event=` param, stood in for by React state (#1503).
 *
 * Which editor is open is the ROUTE's fact — it lives in the URL, the route parses it
 * and owns the two navigations that change it. A component test still has to be able
 * to click "New event" and land in the editor, so this holds the param in state and
 * closes the loop. That is the whole of the route's contract jsdom can honestly
 * observe; the HISTORY behaviour (Back, the pushed-versus-deep-linked close) is proved
 * where a real session history exists —
 * `routes/_app/tournaments.$tournamentId.test.tsx` and
 * `e2e/tournaments/event-editor-history.spec.ts`.
 *
 * Pass `openEditorFor` to pin a starting value, or `onOpenEditor` / `onCloseEditor` to
 * take the wiring over with a spy.
 *
 * Its own file so the page object stays free of component declarations
 * (`react-refresh/only-export-components`), the way the section harnesses are.
 */
export function TournamentDetailPageHarness({
  overrides,
}: {
  overrides: Partial<TournamentDetailPageProps>
}) {
  // Built once: the factory mints a fresh tournament on every call, and handing the
  // page a new one each render is churn no real route produces.
  const [props] = useState(() => buildTournamentDetailPageProps(overrides))
  const [openEditorFor, setOpenEditorFor] = useState(props.openEditorFor)

  return (
    <TournamentDetailPage
      {...props}
      openEditorFor={openEditorFor}
      onOpenEditor={overrides.onOpenEditor ?? setOpenEditorFor}
      onCloseEditor={overrides.onCloseEditor ?? (() => setOpenEditorFor(undefined))}
    />
  )
}
