import { buildPredicate } from '../../../data/seed.factory'
import type { PredicateRowProps } from './predicate-row'

/** Props for `PredicateRow` — a `rating < 1500` numeric rule. */
export function buildPredicateRowProps(
  overrides: Partial<PredicateRowProps> = {},
): PredicateRowProps {
  return {
    predicate: buildPredicate(),
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
