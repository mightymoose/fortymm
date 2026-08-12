import type { DisconnectDialogProps } from './disconnect-dialog'

/** Props for `DisconnectDialog` — the idle dialog: nothing asked for yet, so
 * neither the in-flight line nor the refusal is showing. */
export function buildDisconnectDialogProps(
  overrides: Partial<DisconnectDialogProps> = {},
): DisconnectDialogProps {
  return {
    onConfirm: () => {},
    isPending: false,
    isError: false,
    ...overrides,
  }
}
