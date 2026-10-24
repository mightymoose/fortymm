import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CodeInput } from './CodeInput'

const box = (n: number) => screen.getByRole('textbox', { name: `Character ${n} of 6` })
const values = () => screen.getAllByRole('textbox').map((input) => (input as HTMLInputElement).value)

function renderCode() {
  const onInput = vi.fn()
  const onComplete = vi.fn()
  render(<CodeInput split={3} onInput={onInput} onComplete={onComplete} />)
  return { onInput, onComplete }
}

describe('CodeInput', () => {
  it('takes one uppercased letter or digit per box, moving on after each', async () => {
    const user = userEvent.setup()
    const { onInput, onComplete } = renderCode()

    await user.click(box(1))
    await user.keyboard('s-p2')

    expect(values()).toEqual(['S', 'P', '2', '', '', ''])
    expect(box(4)).toHaveFocus()
    expect(onInput).toHaveBeenLastCalledWith('SP2')
    expect(onComplete).not.toHaveBeenCalled()

    await user.keyboard('6rv')

    expect(onComplete).toHaveBeenCalledExactlyOnceWith('SP26RV')
  })

  it('spreads a pasted code across the boxes from the focused one', async () => {
    const user = userEvent.setup()
    const { onComplete } = renderCode()

    await user.click(box(1))
    await user.paste('sp 26-rv')

    expect(values()).toEqual(['S', 'P', '2', '6', 'R', 'V'])
    expect(box(6)).toHaveFocus()
    expect(onComplete).toHaveBeenCalledWith('SP26RV')
  })

  it('steps back on Backspace in an empty box, clearing the box before', async () => {
    const user = userEvent.setup()
    const { onInput } = renderCode()
    await user.click(box(1))
    await user.keyboard('ab')

    await user.keyboard('{Backspace}')

    expect(values()).toEqual(['A', '', '', '', '', ''])
    expect(box(2)).toHaveFocus()
    expect(onInput).toHaveBeenLastCalledWith('A')
  })

  it('moves between the boxes with ← and →', async () => {
    const user = userEvent.setup()
    renderCode()
    await user.click(box(3))

    await user.keyboard('{ArrowLeft}')
    expect(box(2)).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(box(4)).toHaveFocus()
  })

  it('marks every box invalid and describes it', () => {
    render(
      <>
        <p id="code-error">No tournament uses that code.</p>
        <CodeInput invalid describedBy="code-error" />
      </>,
    )

    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription('No tournament uses that code.')
    }
  })
})
