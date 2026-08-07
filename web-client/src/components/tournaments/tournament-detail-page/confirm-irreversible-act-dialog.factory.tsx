import type {
  ConfirmIrreversibleActDialogProps,
  IrreversibleActConsequence,
} from './confirm-irreversible-act-dialog'

/** The **re-cut** consequence — a standing draw for `Men's Singles` being dealt again. */
export function buildRecutDrawConsequence(
  overrides: Partial<Extract<IrreversibleActConsequence, { variant: 'recut-draw' }>> = {},
): IrreversibleActConsequence {
  return { variant: 'recut-draw', eventName: "Men's Singles", ...overrides }
}

/** The **delete** consequence — the same event's draw being removed outright. */
export function buildDeleteDrawConsequence(
  overrides: Partial<
    Extract<IrreversibleActConsequence, { variant: 'delete-draw' }>
  > = {},
): IrreversibleActConsequence {
  return { variant: 'delete-draw', eventName: "Men's Singles", ...overrides }
}

/** Props for `ConfirmIrreversibleActDialog` — an open **re-cut** confirm on
 * `Men's Singles`. A test that wants the delete act passes a `consequence` of its own. */
export function buildConfirmIrreversibleActDialogProps(
  overrides: Partial<ConfirmIrreversibleActDialogProps> = {},
): ConfirmIrreversibleActDialogProps {
  return {
    open: true,
    consequence: buildRecutDrawConsequence(),
    onConfirm: () => {},
    onCancel: () => {},
    ...overrides,
  }
}
