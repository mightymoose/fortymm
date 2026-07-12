import type { LeadReasonProps } from './lead-reason'

/** Props for `LeadReason` — the closed-window notice by default, since that is
 * the narrowest of its three call sites (the right-aligned column). */
export function buildLeadReasonProps(
  overrides: Partial<LeadReasonProps> = {},
): LeadReasonProps {
  return {
    lead: 'Entries locked',
    reason: 'The tournament is under way.',
    ...overrides,
  }
}
