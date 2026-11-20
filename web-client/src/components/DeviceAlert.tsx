import type { Failure, Unavailable } from '../stores/match-source.ts'
import { Alert } from './Alert.tsx'
import { Button } from './Button.tsx'

// Whether a new deployment of the app is waiting on the device, and the
// switch to it (src/new-version.ts, through `useNewVersion`). A connected
// component hands it to its screen.
export type NewVersionOffer = { waiting: boolean; reload: () => void }

// What the device refused: starting a match, saving or clearing a score
// (nothing was kept), or reading (the list, or one match).
export type DeviceRefusal =
  | { action: 'start' | 'save' | 'clear'; reason: Failure['reason'] }
  | { action: 'read'; reason: Unavailable['reason'] }

type Write = Exclude<DeviceRefusal['action'], 'read'>

// The one place the words for a refusal of this device's storage are
// written, as the user approved them (2026-11-17), by web-client/CLAUDE.md's
// "Error messages": what failed, what we know, what to do. An error alert:
// read out the moment it appears.
//
// - Storage refused: check the browser's site data setting and free space,
//   then try again (a read: Try again alone).
// - A browser feature missing (signing, locks): this browser doesn't
//   support saving; nothing to try here.
// - The core didn't load: part of FortyMM didn't load; try again (a failed
//   load is forgotten, so the next try loads it again).
// - The core didn't load and a new deployment is waiting: the old build's
//   files are likely gone, so the way back is a reload, to the waiting
//   version (`newVersion.reload`, once, from the kept files, so with no
//   connection too). The alert offers Reload, and says when it would drop
//   what is typed (`unsaved`).
//
// For a write, the form's own button tries again; `saved` (a correction's
// saved score, "11–7") says first that it is still saved. A read gives its
// own `title` and `onRetry`, a Try again button.
//
// A clear refused after the person moved to another game shows on that
// game's page, so `game` names the game it was for (the user, 2026-11-20):
// "Couldn't clear game 2's score", "Game 2 is still saved as 11–7.", and a
// next step that opens that game first, since the page's own Clear is
// another game's.
export function DeviceAlert({
  refusal,
  newVersion,
  title,
  saved,
  game,
  unsaved = false,
  heading = false,
  onReload,
  onRetry,
  focusRetry = false,
}: {
  refusal: DeviceRefusal
  newVersion: NewVersionOffer
  // A read's title: what couldn't be loaded.
  title?: string
  saved?: string
  // A clear's: the game it was for, when the page is another game's.
  game?: number
  // Whether a reload would drop what is typed or chosen.
  unsaved?: boolean
  // The title is the page's heading (Alert).
  heading?: boolean
  // Called just before `newVersion.reload`, for a screen that must let the
  // page go without asking (its leave guard).
  onReload?: () => void
  onRetry?: () => void
  // Focus its button (Try again, or Reload in its place) when the alert
  // appears: the screen remounted the alert, to read it out again, under
  // the person's press of the old one's Try again.
  focusRetry?: boolean
}) {
  const reload = refusal.reason === 'core-unavailable' && newVersion.waiting
  const words =
    refusal.action === 'read'
      ? readWords(refusal.reason, reload)
      : writeWords(refusal.action === 'clear' && game !== undefined ? game : refusal.action, refusal.reason, reload, unsaved)
  const stillSaved =
    saved === undefined
      ? undefined
      : game === undefined
        ? `Your saved score is still ${saved}.`
        : `Game ${game} is still saved as ${saved}.`
  const body = [stillSaved, words.body]
    .filter((sentence) => sentence !== undefined)
    .join(' ')
  return (
    <Alert
      tone="error"
      title={words.title ?? title ?? ''}
      heading={heading}
      actions={
        reload ? (
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
      {body === '' ? undefined : body}
    </Alert>
  )
}

const failed: Record<Write, { title: string; again: string; redo: string }> = {
  start: {
    title: 'Couldn’t start the match',
    again: 'Try starting the match again.',
    redo: 'start the match again',
  },
  save: {
    title: 'Couldn’t save your score',
    again: 'Try saving again.',
    redo: 'enter your score again',
  },
  clear: {
    title: 'Couldn’t clear your score',
    again: 'Try clearing it again.',
    redo: 'clear your score again',
  },
}

// The words for a clear of another game than the page's.
const clearOf = (game: number) => ({
  title: `Couldn’t clear game ${game}’s score`,
  again: `Open game ${game} and clear it again.`,
  redo: `clear game ${game}’s score again`,
})

// `action`: a game's number for a clear of that game, from another's page.
function writeWords(
  action: Write | number,
  reason: Failure['reason'],
  reload: boolean,
  unsaved: boolean,
): { title?: string; body?: string } {
  const { title, again, redo } = typeof action === 'number' ? clearOf(action) : failed[action]
  switch (reason) {
    case 'storage-unavailable':
      return {
        title,
        body: 'Check that your browser allows site data and that you have free storage space, then try again.',
      }
    case 'signing-unavailable':
    case 'locks-unavailable':
      return {
        title: 'Your browser doesn’t support saving matches',
        body: 'Update your browser or try another browser.',
      }
    case 'core-unavailable':
      return reload
        ? {
            title,
            body: `Reload FortyMM, then ${redo}.${unsaved ? ' Your unsaved changes will be lost.' : ''}`,
          }
        : { title, body: `Part of FortyMM didn’t load. ${again}` }
  }
}

function readWords(reason: Unavailable['reason'], reload: boolean): { title?: string; body?: string } {
  switch (reason) {
    case 'storage-unavailable':
      return {}
    case 'core-unavailable':
      return {
        body: reload ? 'Reload FortyMM, then try again.' : 'Part of FortyMM didn’t load. Try again.',
      }
  }
}
