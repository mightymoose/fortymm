import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ScrollArea } from './ScrollArea'

describe('ScrollArea', () => {
  it('is a tab stop named by its label, with its heading first', async () => {
    const user = userEvent.setup()
    render(
      <ScrollArea label="Players" heading="Player">
        <p>Nguyen, Thanh</p>
      </ScrollArea>,
    )

    await user.tab()

    const area = screen.getByLabelText('Players')
    expect(area).toHaveFocus()
    expect(area).toHaveTextContent('PlayerNguyen, Thanh')
  })

  it('is not a tab stop without a label', async () => {
    const user = userEvent.setup()
    render(
      <ScrollArea>
        <p>Game scores</p>
      </ScrollArea>,
    )

    await user.tab()

    expect(document.body).toHaveFocus()
  })
})
