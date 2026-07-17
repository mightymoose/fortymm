import type {
  CallConsequence,
  ConfirmCallDialogProps,
  PlacementSummary,
} from './confirm-call-dialog'

/** A placement as the dialog names one — `T1 at 10:30`. */
export function buildPlacementSummary(
  overrides: Partial<PlacementSummary> = {},
): PlacementSummary {
  return { tableLabel: 'T1', time: '10:30', ...overrides }
}

/** Props for `ConfirmCallDialog` — an open **call** confirm (the untold-fixture
 * variant) for `player.1 vs player.4` onto `T1 at 10:30`. A test that wants a
 * correction passes a `consequence` of its own. */
export function buildConfirmCallDialogProps(
  overrides: Partial<ConfirmCallDialogProps> = {},
): ConfirmCallDialogProps {
  const consequence: CallConsequence = {
    variant: 'call',
    to: buildPlacementSummary(),
  }
  return {
    open: true,
    matchLabel: 'player.1 vs player.4',
    consequence,
    onConfirm: () => {},
    onCancel: () => {},
    ...overrides,
  }
}
