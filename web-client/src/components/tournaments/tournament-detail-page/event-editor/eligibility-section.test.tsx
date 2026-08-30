import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

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

  // #1608: the rated/unrated exception belongs to events that HAVE rules. An
  // event with none is simply open to all — qualifying it with who the rules
  // would bind would describe a constraint that does not exist.
  it('adds no rated/unrated qualifier to the no-rules empty state', () => {
    eligibilitySectionPage.render({ event: buildEvent({ predicates: [] }) })
    expect(document.body).not.toHaveTextContent('Unrated players may enter')
    expect(document.body).not.toHaveTextContent('Rated players must satisfy')

    eligibilitySectionPage.render({
      event: buildEvent({ predicates: [] }),
      canEdit: false,
    })
    expect(document.body).not.toHaveTextContent('Unrated players may enter')
    expect(document.body).not.toHaveTextContent('Rated players must satisfy')
  })

  // The three mutations, each asserted against the live form state the section
  // now drives via `useFieldArray` (chore 1e) — not a bridged `onChange` spy.
  describe('the rule list drives the form', () => {
    it('appends a rule to the form when Add rule is clicked', async () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: [buildPredicate()] }),
      })

      await userEvent.click(eligibilitySectionPage.getAddRuleButton())
      expect(eligibilitySectionPage.getPredicates()).toHaveLength(2)
    })

    it('writes an edited rule value into the form', () => {
      eligibilitySectionPage.render({
        event: buildEvent({
          predicates: [buildPredicate({ field: 'rating', op: '<', value: 1500 })],
        }),
      })

      fireEvent.change(eligibilitySectionPage.getValueInput(), {
        target: { value: '1800' },
      })
      expect(eligibilitySectionPage.getPredicates()[0].value).toBe(1800)
    })

    it('removes a rule from the form', async () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
      })
      expect(eligibilitySectionPage.getPredicates()).toHaveLength(2)

      // Remove the first rule; the second must be what survives.
      await userEvent.click(eligibilitySectionPage.getRemoveRuleButtons()[0])
      const remaining = eligibilitySectionPage.getPredicates()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('pr-2')
    })
  })

  // The viewer's subtitle is a strict *prefix* of the organizer's, so neither
  // side can be proved with a substring match — it would match both. Each side
  // is pinned on what discriminates it: the reader's on the exact sentence, the
  // organizer's on the config-speak clause only they can act on.
  //
  // Once a rule exists both voices qualify the sentence with WHO it binds:
  // rated players must satisfy the rules, and an unrated player is admitted
  // (ADR-0783 §3). With no rules the sentence stays unqualified — see the
  // empty-state test above.
  describe('the subtitle', () => {
    const SHARED = 'Players must satisfy every rule to enter.'
    const SCOPED = 'Rated players must satisfy every rule to enter.'

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

    it('scopes the sentence to rated players once a rule exists', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: [buildPredicate()] }),
        canEdit: false,
      })
      expect(screen.getByText(SCOPED, { exact: true })).toBeInTheDocument()
      // The unqualified sentence would erase the unrated exception — it must
      // not survive beside a rule.
      expect(screen.queryByText(SHARED, { exact: true })).toBeNull()
      expect(screen.queryByText(/Empty = open to all/)).toBeNull()
    })

    it('keeps the empty-set config-speak for the organizer even with rules', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: [buildPredicate()] }),
      })
      expect(screen.getByText(/Rated players must satisfy every rule/)).toBeInTheDocument()
      expect(screen.getByText(/Empty = open to all\./)).toBeInTheDocument()
      // The scoped sentence is the prefix of the organizer's node, so the exact
      // match is the reader's node and must be absent here too.
      expect(screen.queryByText(SCOPED, { exact: true })).toBeNull()
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
    // the rules, which is not something a reader is doing. The count sentence
    // names who the rules bind (#1608): rated players — and, beside it, the
    // unrated admission the count alone would erase.
    it('scopes the rule count to rated players and states the unrated admission', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
        canEdit: false,
      })
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'All 2 rules apply to rated players.',
      )
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'Unrated players may enter.',
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
        'All 1 rule applies to rated players.',
      )
    })

    // The organizer gets the same policy plus the AND mechanics — the exception
    // is not swapped out for the config-speak, it stands beside it.
    it('keeps the AND config-speak for the organizer and still states the admission', () => {
      eligibilitySectionPage.render({
        event: buildEvent({ predicates: twoRules() }),
      })
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'All 2 rules apply to rated players.',
      )
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        'Unrated players may enter.',
      )
      expect(eligibilitySectionPage.getFootnote()).toHaveTextContent(
        /Combine with/,
      )
      expect(screen.getByText('AND')).toBeInTheDocument()
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
