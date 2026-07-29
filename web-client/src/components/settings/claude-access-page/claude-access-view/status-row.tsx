import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { Lock, Mail, PowerOff, TriangleAlert } from 'lucide-react'

import type { ClaudeAccessStatus } from '../claude-access-query'
import { AllowAccessButton } from './status-row/allow-access-button'
import { DisconnectButton } from './status-row/disconnect-button'

export interface StatusRowProps {
  /** The single status this page is in — resolved on the way out of the query,
   * never re-derived here. */
  status: ClaudeAccessStatus
}

/** Where a player without an email goes to add one: the email section of the
 * main settings page, which owns that form. */
const EMAIL_SECTION_HASH = 'sec-email'

/** Asking for access is a conversation, not an endpoint — there is no
 * self-serve grant, so the action opens one with the address the login screens
 * already point people at. */
const ASK_FOR_ACCESS_HREF =
  'mailto:support@fortymm.com?subject=Claude%20access'

/**
 * The page's one status row: a pill, a line of copy, and at most one action —
 * except `connected`, which is a card carrying the two facts about the link.
 *
 * Every pill pairs its label with a **glyph**, so the status is legible without
 * colour: the tint is a reinforcement, never the message.
 */
export function StatusRow({ status }: StatusRowProps) {
  const headingId = useId()

  return (
    <section className="fmm-claude__status" aria-labelledby={headingId}>
      <h2 id={headingId} className="fmm-claude__sr-only">
        Connection status
      </h2>
      {status.kind === 'connected' ? (
        <ConnectedCard email={status.email} connectedOn={status.connectedOn} />
      ) : (
        <CompactRow status={status} />
      )}
    </section>
  )
}

/** The five non-connected states, which share one compact row. */
function CompactRow({
  status,
}: {
  status: Exclude<ClaudeAccessStatus, { kind: 'connected' }>
}) {
  return (
    <div className="fmm-claude__row">
      <div className="fmm-claude__row-main">
        {rowPill(status)}
        <p className="fmm-claude__row-copy">{rowCopy(status)}</p>
      </div>
      {rowAction(status)}
    </div>
  )
}

function rowPill(status: Exclude<ClaudeAccessStatus, { kind: 'connected' }>) {
  switch (status.kind) {
    case 'unavailable':
      return (
        <span className="fmm-claude__pill fmm-claude__pill--warn">
          <TriangleAlert aria-hidden="true" size={13} strokeWidth={2.5} />
          UNAVAILABLE
        </span>
      )
    case 'guest':
      return (
        <span className="fmm-claude__pill fmm-claude__pill--warn">
          <Mail aria-hidden="true" size={13} strokeWidth={2.5} />
          EMAIL NEEDED
        </span>
      )
    case 'gated':
      return (
        <span className="fmm-claude__pill fmm-claude__pill--warn">
          <Lock aria-hidden="true" size={13} strokeWidth={2.5} />
          NOT ENABLED
        </span>
      )
    case 'revoked':
      return (
        <span className="fmm-claude__pill fmm-claude__pill--off">
          <PowerOff aria-hidden="true" size={13} strokeWidth={2.5} />
          TURNED OFF
        </span>
      )
    case 'ready':
      return (
        <span className="fmm-claude__pill fmm-claude__pill--ready">
          <span className="ball-dot" aria-hidden="true" />
          READY TO CONNECT
        </span>
      )
  }
}

function rowCopy(status: Exclude<ClaudeAccessStatus, { kind: 'connected' }>) {
  switch (status.kind) {
    case 'unavailable':
      return "We couldn't load your account and connector details. Reload the page, or try again in a minute."
    case 'guest':
      return 'Claude signs in by email. Add one to your account first.'
    case 'gated':
      return "We're switching Claude access on club by club. Requests are declined until yours is on."
    case 'revoked':
      // Says "no agent", not "Claude", because the revocation is per-account:
      // it stops everything signed in with this email at once.
      return 'Claude access is switched off for your account. No agent can read or change anything until you turn it back on.'
    case 'ready':
      return (
        <>
          Use <span className="fmm-claude__mono">{status.email}</span>
        </>
      )
  }
}

function rowAction(status: Exclude<ClaudeAccessStatus, { kind: 'connected' }>) {
  switch (status.kind) {
    case 'guest':
      return (
        <Link
          className="fmm-claude__action"
          to="/settings"
          hash={EMAIL_SECTION_HASH}
        >
          Add an email
        </Link>
      )
    case 'gated':
      return (
        <a className="fmm-claude__action" href={ASK_FOR_ACCESS_HREF}>
          Ask for access
        </a>
      )
    case 'revoked':
      // The one action on this page that is not a link: revocation is sticky,
      // so nothing but this button clears it, and without it the row would be
      // a dead end that quietly 401s every agent request for ever.
      return <AllowAccessButton />
    // "Reload the page" is the whole instruction for `unavailable`, and the
    // browser already has that control; `ready` is answered by the setup panel
    // below it, not by a row action.
    default:
      return null
  }
}

/**
 * The connected state, which is a card rather than a row: it carries two facts
 * a player has to be able to check — *which* account an agent signed in as, and
 * when the link was made — and a row has no room for a labelled pair.
 *
 * The Disconnect button sits in the card head, after the pill and its line of
 * copy: the state, then what it means, then the one thing to do about it.
 */
function ConnectedCard({
  email,
  connectedOn,
}: {
  email: string
  connectedOn: string
}) {
  return (
    <div className="fmm-claude__card">
      <div className="fmm-claude__card-head">
        <span className="fmm-claude__pill fmm-claude__pill--live">
          <span className="ball-dot ball-dot--live" aria-hidden="true" />
          CONNECTED
        </span>
        <p className="fmm-claude__card-copy">Claude can act on your account</p>
        <DisconnectButton />
      </div>
      <dl className="fmm-claude__fields">
        <dt className="fmm-claude__field-label">Signed in as</dt>
        <dd className="fmm-claude__field-value fmm-claude__mono">{email}</dd>
        <dt className="fmm-claude__field-label">Connected</dt>
        <dd className="fmm-claude__field-value">{connectedOn}</dd>
      </dl>
    </div>
  )
}
