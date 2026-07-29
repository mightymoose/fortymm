import { useId } from 'react'

import type { ClaudeAccessView as ClaudeAccessViewModel } from './claude-access-query'
import {
  DetailAccordion,
  type DetailAccordionItem,
} from './claude-access-view/detail-accordion'
import { PermissionsSummary } from './claude-access-view/permissions-summary'
import { SetupPanel } from './claude-access-view/setup-panel'
import { StatusRow } from './claude-access-view/status-row'

export interface ClaudeAccessViewProps {
  /** The projected page state — one status, and whether the grant summary is
   * still worth showing. */
  view: ClaudeAccessViewModel
}

/** What an agent can do on a player's behalf, and how the sign-in works. */
const CAPABILITIES: DetailAccordionItem[] = [
  {
    term: 'Matches',
    detail:
      "start a match, enter scores, propose or accept a result, list what you've played, fix or clear a score.",
  },
  {
    term: 'Tournaments and scheduling',
    detail:
      'create a tournament, enter or withdraw, seed the draw, ask the solver for a schedule, call the winner, and delete a tournament you own.',
  },
  {
    term: 'Players',
    detail: 'search by name or club, read a record, check a head-to-head.',
  },
  {
    term: 'Sign-in',
    detail:
      'you sign in on FortyMM, in your browser, not inside Claude. Claude then holds an OAuth access token for your account and sends it with each request.',
  },
  {
    term: 'What reaches us',
    detail:
      "the requests Claude makes to FortyMM, which can include wording you typed. We don't receive the rest of your conversation.",
  },
  {
    term: 'Revoking',
    detail:
      'disconnect on this page and we stop authorizing requests immediately, even ones using a token Claude already holds.',
  },
]

/** The four ways this goes wrong in practice, each named by its symptom — the
 * only thing a player can actually observe. */
const TROUBLESHOOTING: DetailAccordionItem[] = [
  {
    term: 'Claude says you have no matches',
    detail:
      "it signed in with a different email, so it's reading a different account. Disconnect here, then sign in with the email shown above.",
  },
  {
    term: 'Every request comes back unauthorized',
    detail:
      "the sign-in worked but your account isn't switched on for Claude access yet.",
  },
  {
    term: 'Your email is connected from another Claude account',
    detail: 'disconnect there first, then set it up again.',
  },
  {
    term: "Claude can't reach the connector",
    detail:
      "check the connector URL for a typo. A wrong hostname won't authorize anyone.",
  },
]

/**
 * The body of the Claude access page: one status row, the summary of what is
 * being granted, and the reference material.
 *
 * Pure — everything it branches on is already decided in `selectClaudeAccess`.
 *
 * The setup panel sits between the summary and the accordions, and appears in
 * exactly one state: `ready`. A connected player is past it, a guest and a
 * gated player cannot act on it, and `unavailable` has nothing to put in its
 * fields. **A `revoked` player is the case that matters most**: the steps would
 * work exactly as printed and still leave every agent request 401ing, because
 * the transport refuses a revoked account whatever it pastes — so the panel is
 * withheld and the row's "Allow Claude to connect" is the only thing on offer.
 * The connector null-check is the *parent's* here — `ready` already
 * implies a connector (`resolveStatus` collapses the other way round), so this
 * is belt-and-braces against a panel with an empty field to copy, which is the
 * one thing it must never render.
 */
export function ClaudeAccessView({ view }: ClaudeAccessViewProps) {
  const detailHeadingId = useId()

  return (
    <>
      <StatusRow status={view.status} />
      {view.showsPermissionsSummary && (
        <PermissionsSummary username={view.username} />
      )}
      {view.status.kind === 'ready' && view.connector !== null && (
        <SetupPanel connector={view.connector} email={view.status.email} />
      )}
      <section
        className="fmm-claude__detail"
        aria-labelledby={detailHeadingId}
      >
        <p className="fmm-claude__overline" id={detailHeadingId}>
          More detail
        </p>
        <DetailAccordion
          title="Capabilities and security"
          items={CAPABILITIES}
        />
        <DetailAccordion title="Troubleshooting" items={TROUBLESHOOTING} />
      </section>
    </>
  )
}
