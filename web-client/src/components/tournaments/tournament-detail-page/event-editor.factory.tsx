import { buildDrawTypes, buildEvent, buildTables } from '../data/seed.factory'
import type { EventEditorProps } from './event-editor'

/** Props for `EventEditor` — open, editing the seeded Open Singles event. */
export function buildEventEditorProps(
  overrides: Partial<EventEditorProps> = {},
): EventEditorProps {
  // `'event' in overrides`, not `overrides.event ?? …`: a test asserting the
  // read-only-view-of-nothing case passes `event: null` on purpose, and `??` would
  // silently replace that `null` with a seeded event. `?? null` on the read only
  // narrows `overrides.event`'s type (`TournamentEvent | null | undefined`, from
  // `Partial<EventEditorProps>`) down to what the prop actually accepts — the key's
  // presence, checked above, already rules out an ACTUAL `undefined` reaching here.
  const event = ('event' in overrides ? overrides.event : buildEvent()) ?? null
  return {
    open: true,
    onOpenChange: () => {},
    event,
    // The server's CURRENT version for this event, by default equal to the opened
    // event's own — so a bare render is never already sitting in a conflict it never
    // asked for (#1499). A test that WANTS the conflict banner overrides this to a
    // different number, or to `null` for the deleted-elsewhere case.
    currentLockVersion: event?.lockVersion ?? null,
    tables: buildTables(12),
    drawTypes: buildDrawTypes(),
    canEdit: true,
    // No write in flight — the editor as an organizer first meets it.
    saving: false,
    onSave: () => {},
    onDelete: () => {},
    ...overrides,
  }
}
