import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Toggle } from './Toggle'

describe('Toggle', () => {
  it('renders an unpressed button named by its aria-label', () => {
    render(<Toggle aria-label="Bold">B</Toggle>)

    const bold = screen.getByRole('button', { name: 'Bold', pressed: false })
    expect(bold).toHaveAttribute('type', 'button')
    expect(bold).toHaveClass('toggle')
    expect(bold).toHaveTextContent('B')
  })

  it('starts pressed when told', () => {
    render(
      <Toggle aria-label="Bold" defaultPressed>
        B
      </Toggle>,
    )

    expect(
      screen.getByRole('button', { name: 'Bold', pressed: true }),
    ).toBeInTheDocument()
  })

  it('flips with a click', async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    render(
      <Toggle aria-label="Bold" onPressedChange={onPressedChange}>
        B
      </Toggle>,
    )
    const bold = screen.getByRole('button', { name: 'Bold' })

    await user.click(bold)
    expect(bold).toHaveAttribute('aria-pressed', 'true')

    await user.click(bold)
    expect(bold).toHaveAttribute('aria-pressed', 'false')
    expect(onPressedChange.mock.calls).toEqual([[true], [false]])
  })

  it('flips with Space and Enter when focused', async () => {
    const user = userEvent.setup()
    render(<Toggle aria-label="Bold">B</Toggle>)
    const bold = screen.getByRole('button', { name: 'Bold' })

    await user.tab()
    expect(bold).toHaveFocus()
    await user.keyboard(' ')
    expect(bold).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Enter}')
    expect(bold).toHaveAttribute('aria-pressed', 'false')
  })

  it('can be controlled', async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    function Controlled() {
      const [pressed, setPressed] = useState(true)
      return (
        <Toggle
          aria-label="Bold"
          pressed={pressed}
          onPressedChange={(next) => {
            onPressedChange(next)
            setPressed(next)
          }}
        >
          B
        </Toggle>
      )
    }
    render(<Controlled />)
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveAttribute('aria-pressed', 'true')

    await user.click(bold)
    expect(onPressedChange).toHaveBeenLastCalledWith(false)
    expect(bold).toHaveAttribute('aria-pressed', 'false')
  })

  it('stays as its pressed prop says when onPressedChange ignores the click', async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    render(
      <Toggle aria-label="Bold" pressed onPressedChange={onPressedChange}>
        B
      </Toggle>,
    )
    const bold = screen.getByRole('button', { name: 'Bold' })

    await user.click(bold)
    expect(onPressedChange).toHaveBeenCalledWith(false)
    expect(bold).toHaveAttribute('aria-pressed', 'true')
  })

  it("doesn't flip when disabled", async () => {
    const user = userEvent.setup()
    const onPressedChange = vi.fn()
    render(
      <Toggle aria-label="Bold" disabled onPressedChange={onPressedChange}>
        B
      </Toggle>,
    )
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toBeDisabled()

    await user.click(bold)
    expect(bold).toHaveAttribute('aria-pressed', 'false')
    expect(onPressedChange).not.toHaveBeenCalled()
  })

  it('passes its props to the button and still calls onClick', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Toggle aria-label="Bold" className="extra" onClick={onClick}>
        B
      </Toggle>,
    )
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold).toHaveClass('toggle', 'extra')

    await user.click(bold)
    expect(onClick).toHaveBeenCalledOnce()
    expect(bold).toHaveAttribute('aria-pressed', 'true')
  })
})
