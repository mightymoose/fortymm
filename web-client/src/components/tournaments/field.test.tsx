import { Input } from '@/components/ui/input'

import { fieldPage } from './field.page'

describe('Field', () => {
  it('associates its label with the control via the generated id', () => {
    fieldPage.render({
      label: 'Venue name',
      children: (id) => <Input id={id} />,
    })
    expect(fieldPage.getControl('Venue name')).toBeInTheDocument()
  })

  it('renders a hint as error text when error is set', () => {
    fieldPage.render({ hint: 'Required', error: true })
    const hint = fieldPage.queryHint('Required')
    expect(hint).toHaveClass('text-[color:var(--loss)]')
    expect(hint).not.toHaveAttribute('role')
  })

  it('live-announces an error only when the caller opts in', () => {
    fieldPage.render({ hint: 'Save was refused', error: true, announceError: true })
    const hint = fieldPage.queryHint('Save was refused')
    expect(hint).toHaveAttribute('role', 'alert')
  })

  // The hint is the sentence that explains the control — a validation message, or the
  // reason a control is frozen (ADR-0786). Rendered as a bare `<p>` with no `id` it is
  // *below* the control on screen and nowhere at all in the accessibility tree, which
  // is how the draw-type select came to be disabled, explained in text, and yet
  // `aria-describedby: null` to anyone hearing the page rather than seeing it.
  describe('the hint association', () => {
    it('hands the control the id of the hint it renders', () => {
      fieldPage.render({ label: 'Player limit', hint: 'Blank = no cap.' })

      const describedBy = fieldPage
        .getControl('Player limit')
        .getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      // …and it resolves to the hint itself. Asserting merely that *an* id is set would
      // pass on one pointing at nothing — a description that describes nothing.
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        'Blank = no cap.',
      )
    })

    it('hands the control NO id when the row shows no hint', () => {
      // A dangling `aria-describedby` is a WCAG failure of its own
      // (`aria-valid-attr-value`), so the row must hand out `undefined` — not an id
      // for an element it never rendered.
      fieldPage.render({ label: 'Player limit' })

      expect(fieldPage.getControl('Player limit')).not.toHaveAttribute(
        'aria-describedby',
      )
    })
  })

  // ADR 0015: `Field` owns the read-only *branch*, not merely a flag. The row is
  // handed both its control and the value it holds, and decides between them —
  // so a call site cannot leak a live control to a reader by forgetting a
  // `canEdit ? … : …` of its own. That leak is structurally impossible here
  // rather than merely swept for.
  describe('readOnly', () => {
    it('renders the control for an editor', () => {
      fieldPage.render({
        label: 'Entry fee',
        value: 30,
        children: (id) => <Input id={id} defaultValue={30} />,
      })
      expect(fieldPage.getControl('Entry fee')).toBeInTheDocument()
    })

    it('renders the value instead of the control for a viewer', () => {
      fieldPage.render({
        label: 'Entry fee',
        readOnly: true,
        value: 30,
        children: (id) => <Input id={id} defaultValue={30} />,
      })
      expect(fieldPage.getFieldValue('Entry fee')).toHaveTextContent('30')
      expect(fieldPage.queryControl('Entry fee')).toBeNull()
    })

    it('renders an em-dash for a value the organizer left unset', () => {
      fieldPage.render({ label: 'Entry fee', readOnly: true, value: null })
      expect(fieldPage.getFieldValue('Entry fee')).toHaveTextContent('—')
    })
  })

  // ADR 0015: the hint and the asterisk are the form's *furniture*. They explain
  // how to fill in a control and mark one you must complete — both nonsense next
  // to a value nobody can edit. Suppressing them here rather than at each call
  // site is what stops a newly added field from reintroducing them by omission,
  // so both sides are asserted: an editor keeps them, a viewer never sees them.
  describe('furniture', () => {
    const FURNITURE = {
      label: 'Player limit',
      required: true,
      hint: 'Hard cap. Waitlist opens past this.',
    }

    it('shows the required asterisk and the hint to an editor', () => {
      fieldPage.render(FURNITURE)
      expect(fieldPage.getLabelText('Player limit')).toContain('*')
      expect(
        fieldPage.queryHint('Hard cap. Waitlist opens past this.'),
      ).toBeInTheDocument()
    })

    it('drops both for a read-only row, keeping the label', () => {
      fieldPage.render({ ...FURNITURE, readOnly: true })
      expect(fieldPage.getLabelText('Player limit')).toBe('Player limit')
      expect(fieldPage.getLabelText('Player limit')).not.toContain('*')
      expect(
        fieldPage.queryHint('Hard cap. Waitlist opens past this.'),
      ).toBeNull()
    })

    // A read-only row renders no control, so a `for` would point at nothing. An
    // orphaned label is not an association — it just looks like one.
    it('leaves no dangling label association when there is no control', () => {
      fieldPage.render({ ...FURNITURE, readOnly: true })
      expect(fieldPage.getLabel('Player limit')).not.toHaveAttribute('for')
    })

    it('associates the label with the control for an editor', () => {
      fieldPage.render({ ...FURNITURE, readOnly: false })
      expect(fieldPage.getLabel('Player limit')).toHaveAttribute('for')
    })
  })
})
