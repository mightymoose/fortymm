import type { NewTournamentModalProps } from './new-tournament-modal'

/** Props for `NewTournamentModal` — open, with no-op handlers. */
export function buildNewTournamentModalProps(
  overrides: Partial<NewTournamentModalProps> = {},
): NewTournamentModalProps {
  return {
    open: true,
    onOpenChange: () => {},
    onCreate: () => {},
    ...overrides,
  }
}
