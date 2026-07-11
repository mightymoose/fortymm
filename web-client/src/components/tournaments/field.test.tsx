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
    expect(fieldPage.queryHint('Required')).toHaveClass('text-[color:var(--loss)]')
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
  })
})
