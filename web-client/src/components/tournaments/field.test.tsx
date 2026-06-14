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
})
