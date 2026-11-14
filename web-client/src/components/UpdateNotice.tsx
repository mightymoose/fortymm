import { Icon } from './Icon.tsx'
import './UpdateNotice.css'

// Says a new version of the app is on the device and ready, with Reload to
// switch to it and a button to dismiss it (src/new-version.ts decides when).
// Not one of the design system's four feedback roles, so a part of its own,
// built as its nearest sibling is: the toast's shape (.fm-toast: one compact
// line on bg-group, the overlay shadow, one action and a dismiss button), as
// the layout lays it over every screen, bottom centre, out of the page's flow
// so nothing on the screen moves. Unlike a toast it is no success (its icon
// is grey, refresh-cw, not the success check) and it stays until it is
// answered: no timer.
//
// The status region is always there, and the notice appears inside it when
// `shown`, so assistive technology reads it out politely when it appears,
// without moving focus.
export function UpdateNotice({
  shown,
  onReload,
  onDismiss,
}: {
  shown: boolean
  onReload: () => void
  onDismiss: () => void
}) {
  return (
    <div className="update-notice" role="status">
      {shown && (
        <div className="update-notice__box">
          <Icon name="refresh-cw" />
          <span className="update-notice__message">A new version is ready.</span>
          <button
            type="button"
            className="update-notice__action"
            onClick={onReload}
          >
            Reload
          </button>
          <button
            type="button"
            className="update-notice__dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
    </div>
  )
}
