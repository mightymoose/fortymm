import { buildDrawTypes, buildEvent, buildTables } from '../data/seed.factory'
import type { EventEditorProps } from './event-editor'

/** Props for `EventEditor` — open, editing the seeded Open Singles event. */
export function buildEventEditorProps(
  overrides: Partial<EventEditorProps> = {},
): EventEditorProps {
  return {
    open: true,
    onOpenChange: () => {},
    event: buildEvent(),
    tables: buildTables(12),
    drawTypes: buildDrawTypes(),
    canEdit: true,
    onSave: () => {},
    onDelete: () => {},
    ...overrides,
  }
}
