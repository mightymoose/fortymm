import { buildPredicate } from '../../../data/seed.factory'
import type { PredicateRowProps } from './predicate-row'

/** Props for `PredicateRow` — a `rating < 1500` numeric rule, editable (the
 * creator's view). Pass `canEdit: false` for a viewer's read-only sentence. */
export function buildPredicateRowProps(
  overrides: Partial<PredicateRowProps> = {},
): PredicateRowProps {
  return {
    predicate: buildPredicate(),
    canEdit: true,
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
