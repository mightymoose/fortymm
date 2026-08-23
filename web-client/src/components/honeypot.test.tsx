import userEvent from '@testing-library/user-event'

import { render, screen } from '@/test/utilities'

import { buildHoneypotProps } from './honeypot.factory'
import { Honeypot } from './honeypot'
import { honeypotPage } from './honeypot.page'

describe('Honeypot', () => {
  it('stays in the DOM but out of the focus order and accessibility tree', () => {
    honeypotPage.render()

    const wrapper = honeypotPage.getWrapper()
    // The hiding is a human's only protection (a tripped trap never warns),
    // so pin both attributes directly — a role query alone under-proves.
    expect(wrapper).toHaveAttribute('inert')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect(honeypotPage.getInput()).toHaveAttribute('tabindex', '-1')

    expect(honeypotPage.queryAccessibleTextbox()).toBeNull()
  })

  it('keeps the trap wired for bots that parse and fill it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    honeypotPage.render({ value: 'bot@example.com', onChange })

    const input = honeypotPage.getLabelledInput() as HTMLInputElement
    expect(input).toBe(honeypotPage.getInput())

    await user.type(input, '!')

    expect(onChange).toHaveBeenCalledWith('bot@example.com!')
  })

  it('gives two mounted traps distinct ids so their labels cannot cross', () => {
    render(
      <>
        <Honeypot {...buildHoneypotProps({ testId: 'honeypot-a' })} />
        <Honeypot {...buildHoneypotProps({ testId: 'honeypot-b' })} />
      </>,
    )

    const a = screen.getByTestId('honeypot-a')
    const b = screen.getByTestId('honeypot-b')

    expect(a.id).not.toBe('')
    expect(b.id).not.toBe('')
    expect(a.id).not.toBe(b.id)
  })
})
