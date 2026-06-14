import type { ConfirmDeleteDialogProps } from './confirm-delete-dialog'

/** Props for `ConfirmDeleteDialog` — an open "delete tournament" prompt. */
export function buildConfirmDeleteDialogProps(
  overrides: Partial<ConfirmDeleteDialogProps> = {},
): ConfirmDeleteDialogProps {
  return {
    open: true,
    onOpenChange: () => {},
    kind: 'tournament',
    name: 'Bay Area Open 2026',
    onConfirm: () => {},
    ...overrides,
  }
}
