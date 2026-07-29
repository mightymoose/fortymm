import { cn } from '@/lib/utils'

import { useAllowAgentAccess } from '../../claude-access-query'

/** What the live region says while the request is in flight. */
const PENDING_NOTE = 'Switching Claude access back on…'

/** What it says when the request came back anything other than 200. Deliberately
 * a sentence about *this page's* attempt, not the server's words: the row's
 * whole job is to be the way back, so a failure has to read as "that didn't
 * work, press it again" rather than leave the button looking inert. */
const FAILURE_NOTE =
  "We couldn't switch Claude access back on. Try again in a moment."

/**
 * The revoked row's action: turn agent access back on for this account.
 *
 * The only component on the page that mutates, and it owns its own mutation
 * rather than take a callback from above — so the status row and the view stay
 * pure, and the "did it work" states (in flight, refused) live next to the
 * button that produced them instead of being threaded through two layers of
 * props.
 *
 * On success the mutation writes the server's new payload into the page's
 * query cache (see `useAllowAgentAccess`), so this component unmounts as the
 * page re-renders in whichever state the server reports — ordinarily `ready`,
 * with the setup panel back.
 */
export function AllowAccessButton() {
  const { mutate, isPending, isError } = useAllowAgentAccess()

  return (
    <div className="fmm-claude__allow">
      <button
        type="button"
        className="fmm-claude__action fmm-claude__action--primary"
        // Only while the request is in flight — a second press would be a
        // second POST with nothing to show for it. A refusal re-enables it,
        // because pressing again is the entire remedy.
        disabled={isPending}
        onClick={() => mutate()}
      >
        Allow Claude to connect
      </button>
      {/* Present from first paint (empty when idle) so a screen reader actually
          announces what lands in it; `:empty` keeps it out of the layout. */}
      <p
        className={cn(
          'fmm-claude__allow-note',
          isError && 'fmm-claude__allow-note--failed',
        )}
        role="status"
      >
        {isPending ? PENDING_NOTE : isError ? FAILURE_NOTE : ''}
      </p>
    </div>
  )
}
