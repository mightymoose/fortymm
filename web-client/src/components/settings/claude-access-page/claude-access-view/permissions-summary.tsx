import { useId } from 'react'

export interface PermissionsSummaryProps {
  /** The account every agent action will appear under — named in the first
   * line, because "as you" is the whole point of the grant. */
  username: string
}

/**
 * What a player is agreeing to before they connect an agent. A consent surface,
 * so it is written to be *complete*, not comfortable:
 *
 * - It says **deletes**. The agent can delete game scores, events, tournaments,
 *   draws and entries, and there is no server-side confirmation step standing
 *   between it and any of them. Softening this to "creates and updates" would
 *   make the grant read smaller than it is, which is the one failure this page
 *   must not have. Do not reword it.
 * - It says the agent can never exceed the player. That is a *verified*
 *   property, not a reassurance: every MCP tool re-checks the same permission
 *   its HTTP route checks.
 */
export function PermissionsSummary({ username }: PermissionsSummaryProps) {
  const headingId = useId()

  return (
    <section className="fmm-claude__grant" aria-labelledby={headingId}>
      <p className="fmm-claude__overline" id={headingId}>
        What you're granting
      </p>
      <ul className="fmm-claude__grant-list">
        <li className="fmm-claude__grant-item">
          <span className="ball-dot" aria-hidden="true" />
          <span>
            Claude creates, updates <strong>and deletes</strong> matches, entries
            and draws <strong>as you</strong> — everything appears under{' '}
            <span className="fmm-claude__mono">{username}</span>.
          </span>
        </li>
        <li className="fmm-claude__grant-item">
          <span className="ball-dot" aria-hidden="true" />
          <span>
            It reads your account data and public player records — never another
            player's private account.
          </span>
        </li>
        <li className="fmm-claude__grant-item">
          <span className="ball-dot" aria-hidden="true" />
          <span>
            Claude can never do more than you can do yourself — every action is
            held to your own permissions.
          </span>
        </li>
        <li className="fmm-claude__grant-item">
          <span className="ball-dot" aria-hidden="true" />
          <span>
            You can disconnect at any time. Anything Claude logged stays on your
            account.
          </span>
        </li>
      </ul>
    </section>
  )
}
