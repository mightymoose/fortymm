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

/** The **publish** consequence — a draft tournament opening to the public. Named after a
 * *tournament*, not an event: a lifecycle act moves the whole thing. */
export function buildPublishTournamentConsequence(
  overrides: Partial<
    Extract<IrreversibleActConsequence, { variant: 'publish-tournament' }>
  > = {},
): IrreversibleActConsequence {
  return {
    variant: 'publish-tournament',
    tournamentName: 'Bay Area Open 2026',
    ...overrides,
  }
}

/** The **start** consequence — registration closing and every ready fixture becoming a
 * real match (#788). */
export function buildStartTournamentConsequence(
  overrides: Partial<
    Extract<IrreversibleActConsequence, { variant: 'start-tournament' }>
  > = {},
): IrreversibleActConsequence {
  return {
    variant: 'start-tournament',
    tournamentName: 'Bay Area Open 2026',
    ...overrides,
  }
}

/** The **end** consequence — the move into `archived`, which has no edge out of it. */
export function buildEndTournamentConsequence(
  overrides: Partial<
    Extract<IrreversibleActConsequence, { variant: 'end-tournament' }>
  > = {},
): IrreversibleActConsequence {
  return {
    variant: 'end-tournament',
    tournamentName: 'Bay Area Open 2026',
    ...overrides,
  }
}

/** The **lowered pool count** consequence — two of `Men's Singles`' pool reservations
 * going, with the windows and the tables they hold (ADR 20260808). Two names rather than
 * one, because the plural is the ordinary case and the singular is the edge. */
export function buildRemovePoolReservationsConsequence(
  overrides: Partial<
    Extract<IrreversibleActConsequence, { variant: 'remove-pool-reservations' }>
  > = {},
): IrreversibleActConsequence {
  return {
    variant: 'remove-pool-reservations',
    eventName: "Men's Singles",
    poolNames: ['Pool E', 'Pool F'],
    ...overrides,
  }
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
