import type { Failure, Unavailable } from '../stores/match-source.ts'
import { Alert } from './Alert.tsx'
import { Button } from './Button.tsx'

// Whether a new deployment of the app is waiting on the device, and the
// switch to it (src/new-version.ts, through `useNewVersion`). A connected
// component hands it to its screen.
export type NewVersionOffer = { waiting: boolean; reload: () => void }

// What the device refused: a write (nothing was kept) or a read.
export type DeviceRefusal =
  | { action: 'write'; reason: Failure['reason'] }
  | { action: 'read'; reason: Unavailable['reason'] }

// The one place the words for a refusal of this device's storage are
// written (PLAN-match-store-and-sync.md §3, as the user approved them on
// 2026-11-16). An error alert: read out the moment it appears.
//
// - Storage or its locks refused: the browser isn't letting FortyMM store
//   (or read) its data.
// - Signing refused: the browser isn't letting FortyMM sign it.
// - The core didn't load: "Try again." (a failed load is forgotten, so the
//   next try loads it again). But when a new deployment is waiting, the old
//   build's files are likely gone: the alert says so and offers Reload,
//   which switches to the waiting version (`newVersion.reload`, once, from
//   the kept files, so with no connection too). `lost` is said after it:
//   what the reload would drop.
// - `onRetry` adds a Try again button, for a read; Reload takes its place
//   when it is offered.
export function DeviceAlert({
  title,
  refusal,
  newVersion,
  lost,
  onReload,
  onRetry,
  focusRetry = false,
}: {
  title: string
  refusal: DeviceRefusal
  newVersion: NewVersionOffer
  lost?: string
  // Called just before `newVersion.reload`, for a screen that must let the
  // page go without asking (its leave guard).
  onReload?: () => void
  onRetry?: () => void
  // Focus its button (Try again, or Reload in its place) when the alert
  // appears: the screen remounted the alert, to read it out again, under
  // the person's press of the old one's Try again.
  focusRetry?: boolean
}) {
  const update = refusal.reason === 'core-unavailable' && newVersion.waiting
  return (
    <Alert
      tone="error"
      title={title}
      actions={
        update ? (
          <Button
            variant="secondary"
            size="sm"
            autoFocus={focusRetry}
            onClick={() => {
              onReload?.()
              newVersion.reload()
            }}
          >
            Reload
          </Button>
        ) : onRetry !== undefined ? (
          <Button variant="secondary" size="sm" onClick={onRetry} autoFocus={focusRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {update
        ? ['Plot twist: a new FortyMM arrived mid-match. Reload to switch to it, then try again.', lost]
            .filter((sentence) => sentence !== undefined)
            .join(' ')
        : body(refusal)}
    </Alert>
  )
}

function body({ action, reason }: DeviceRefusal): string {
  switch (reason) {
    case 'storage-unavailable':
    case 'locks-unavailable':
      return action === 'write'
        ? 'This browser isn’t letting FortyMM store data.'
        : 'This browser isn’t letting FortyMM read its data.'
    case 'signing-unavailable':
      return 'This browser isn’t letting FortyMM sign it.'
    case 'core-unavailable':
      return 'Try again.'
  }
}
