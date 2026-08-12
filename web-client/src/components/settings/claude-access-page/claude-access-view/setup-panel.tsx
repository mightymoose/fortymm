import { useId } from 'react'

import type { ClaudeConnector } from '../claude-access-query'
import { ClaudeDialogDiagram } from './setup-panel/claude-dialog-diagram'
import { CopyField, type CopyFieldOutcome } from './setup-panel/copy-field'
import {
  useCopyToClipboard,
  type CopyFieldId,
  type CopyOutcome,
} from './setup-panel/use-copy-to-clipboard'

export interface SetupPanelProps {
  /** The pair a player pastes into Claude. Non-null by construction: the parent
   * renders this only in `ready`, and a missing connector resolves to
   * `unavailable` instead — a field with nothing in it is the one thing a
   * copy-this-value panel must never show. */
  connector: ClaudeConnector
  /** The account Claude has to sign in as for any of this to reach the right
   * player. */
  email: string
}

/**
 * What each field is called when the live region names it: the visible label
 * without its "where to find it" aside, which reads as noise out loud.
 */
const FIELD_NAMES: Record<CopyFieldId, string> = {
  url: 'Connector URL',
  clientId: 'Client ID',
}

/**
 * What the live region says about the last copy attempt — empty until there has
 * been one.
 *
 * It names the **field**, not just the act: with two copy buttons a bare
 * "Copied" leaves a screen-reader user unable to tell which value they now
 * hold, which is precisely the confusion the visible marker exists to prevent.
 */
function announce(outcome: CopyOutcome | null): string {
  if (outcome === null) return ''
  const name = FIELD_NAMES[outcome.field]
  return outcome.ok
    ? `${name} copied to the clipboard.`
    : `We couldn't copy the ${name}. Select the value and copy it yourself.`
}

/**
 * The centre of the page: the three steps that connect Claude to this account,
 * with the two values to paste sitting in the one a player is on when they need
 * them.
 *
 * Rendered **only in the `ready` state**. Connected players are past it, guests
 * and gated players can't act on it, and a deployment with no connector has
 * nothing to put in the fields.
 */
export function SetupPanel({ connector, email }: SetupPanelProps) {
  const headingId = useId()
  const { outcome, copy } = useCopyToClipboard()

  /** The marker belongs to whichever field was copied last — never to both. */
  const outcomeFor = (field: CopyFieldId): CopyFieldOutcome => {
    if (outcome === null || outcome.field !== field) return null
    return outcome.ok ? 'copied' : 'failed'
  }

  return (
    <section className="fmm-claude__setup" aria-labelledby={headingId}>
      <h2 className="fmm-claude__setup-title" id={headingId}>
        Set up Claude access
      </h2>
      <ol className="fmm-claude__steps">
        <li className="fmm-claude__step">
          <span className="fmm-claude__step-num" aria-hidden="true">
            1
          </span>
          <div className="fmm-claude__step-body">
            <p className="fmm-claude__step-copy">
              In Claude, open{' '}
              <strong>Settings → Connectors → Add custom connector</strong>
            </p>
          </div>
        </li>

        <li className="fmm-claude__step">
          <span className="fmm-claude__step-num" aria-hidden="true">
            2
          </span>
          <div className="fmm-claude__step-body">
            <p className="fmm-claude__step-copy">
              Paste the connector URL and the client ID
            </p>
            <CopyField
              label="Connector URL"
              value={connector.url}
              buttonLabel="Copy URL"
              tone="primary"
              outcome={outcomeFor('url')}
              onCopy={() => copy('url', connector.url)}
            />
            <CopyField
              label="Client ID · under Advanced settings"
              value={connector.client_id}
              buttonLabel="Copy client ID"
              tone="secondary"
              outcome={outcomeFor('clientId')}
              onCopy={() => copy('clientId', connector.client_id)}
            />
            <p className="fmm-claude__notice">Leave client secret empty</p>
            <ClaudeDialogDiagram />
          </div>
        </li>

        <li className="fmm-claude__step">
          <span className="fmm-claude__step-num" aria-hidden="true">
            3
          </span>
          <div className="fmm-claude__step-body">
            <p className="fmm-claude__step-copy">
              Select Connect, and sign in with this email
            </p>
            <div className="fmm-claude__email-block">
              <p className="fmm-claude__email">{email}</p>
              <p className="fmm-claude__email-note">
                Choose this account when Claude asks you to sign in. Another
                email opens a different FortyMM account.
              </p>
            </div>
            <p className="fmm-claude__step-copy">
              Then ask Claude{' '}
              <code className="fmm-claude__code">list my matches</code>. If
              Claude returns your recent matches, you're connected.
            </p>
          </div>
        </li>
      </ol>
      {/* Present from first paint, and empty until a copy lands: a live region
          added to the DOM *with* its message is not reliably announced.
          Polite, never assertive — pressing Copy is the player's own doing, so
          interrupting whatever they were reading would be rude, not helpful. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announce(outcome)}
      </p>
    </section>
  )
}
