import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

import { buildEvent, buildPredicate } from '../../data/seed.factory'
import { eligibilitySectionPage } from './eligibility-section.page'

/** A rating rule and a between-rule — the two shapes a viewer reads. */
const twoRules = () => [
  buildPredicate({ id: 'pr-1', field: 'rating', op: '<', value: 1500 }),
  buildPredicate({
    id: 'pr-2',
    field: 'rating',
    op: 'between',
    value: [1200, 1500],
  }),
]

describe('EligibilitySection', () => {
  it('shows the open-to-all empty state with no rules', () => {
    eligibilitySectionPage.render({ event: buildEvent({ predicates: [] }) })
    expect(eligibilitySectionPage.queryRows()).toHaveLength(0)
    expect(document.body).toHaveTextContent('Open to all players')
  })

  it('appends a rule when Add rule is clicked', async () => {
    const onChange = vi.fn()
    eligibilitySectionPage.render({
      event: buildEvent({ predicates: [buildPredicate()] }),
      onChange,
    })

    await userEvent.click(eligibilitySectionPage.getAddRuleButton())
    expect(onChange.mock.calls.at(-1)?.[0].predicates).toHaveLength(2)
  })

  // The viewer's subtitle is a strict *prefix* of the organizer's, so neither
  // side can be proved with a substring match — it would match both. Each side
  // is pinned on what discriminates it: the reader's on the exact sentence, the
  // organizer's on the config-speak clause only they can act on.
  describe('the subtitle', () => {
    const SHARED = 'Players must satisfy every rule to enter.'

    it('tells the organizer what an empty rule set does', () => {
      eligibilitySectionPage.render({ event: buildEvent() })
      expect(screen.getByText(/Empty = open to all\./)).toBeInTheDocument()
      // The organizer's subtitle is the shared sentence *plus* that clause, so
      // the exact shared sentence must not be the whole of any node.
      expect(screen.queryByText(SHARED, { exact: true })).toBeNull()
    })

    it('drops the config-speak for a non-owner', () => {
      eligibilitySectionPage.render({ event: buildEvent(), canEdit: false })
      expect(screen.getByText(SHARED, { exact: true })).toBeInTheDocument()
      expect(screen.queryByText(/Empty = open to all/)).toBeNull()
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6). Rendered *with* rules on purpose: an
    // empty event has nothing but the Add button, so a sweep over the default
    // would never touch the rule builder's selects and number inputs — the
    // controls most likely to be left live.
    it('renders no interactive controls', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(eligibilitySectionPage.getFormElements()).toHaveLength(0)
      expect(eligibilitySectionPage.getInteractiveControls()).toHaveLength(0)
    })

    it('reads each rule as a sentence', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })

      const [first, second] = eligibilitySectionPage.queryRows()
      expect(first).toHaveTextContent('Rating is less than 1500')
      expect(second).toHaveTextContent('Rating is between 1200 and 1500')
    })

    // Column headers label controls. With no controls they label nothing.
    it('drops the Field / Operator / Value column headers', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })
      expect(eligibilitySectionPage.queryColumnHeaders()).toBeNull()
    })

    // Hidden, never disabled: a disabled button is an unexplained dead end.
    it('hides the Add rule and Remove rule buttons', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })
      expect(eligibilitySectionPage.queryAddRuleButton()).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Remove rule' }),
      ).toBeNull()
    })

    // "Combine with AND" is config-speak — it explains how the builder assembles
    // the rules, which is not something a reader is doing.
    it('states the rule count without the AND config-speak', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'All 2 rules must match.',
      )
      expect(eligibilitySectionPage.getFootnote()).not.toHaveTextContent(
        /Combine with/,
      )
      expect(screen.queryByText('AND')).toBeNull()
    })

    it('keeps the singular for a lone rule', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: [buildPredicate()] }),
        canEdit: false,
      })
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'All 1 rule must match.',
      )
    })

    // The empty state already reads correctly for a viewer — it just must not
    // offer them a rule to add.
    it('shows the open-to-all empty state with no Add button', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: [] }),
        canEdit: false,
      })
      expect(screen.getByText('Open to all players')).toBeInTheDocument()
      expect(eligibilitySectionPage.queryAddRuleButton()).toBeNull()
      expect(eligibilitySectionPage.getFormElements()).toHaveLength(0)
    })
  })
})
