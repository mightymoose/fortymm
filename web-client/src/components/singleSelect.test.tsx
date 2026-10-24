import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useSingleSelect } from './singleSelect'
import { ToastProvider } from './ToastProvider'

// A group of pressed buttons, the kind that no component of the app uses yet,
// such as the gallery's schedule timeline.
function PressedGroup({ labels }: { labels: string[] }) {
  const { optionProps } = useSingleSelect('pressed', labels)
  return (
    <div>
      {labels.map((label, index) => (
        <button key={label} type="button" {...optionProps(index)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function renderGroup() {
  render(
    <ToastProvider>
      <PressedGroup labels={['Table 1', 'Table 2', 'Table 3']} />
    </ToastProvider>,
  )
}

const button = (name: string) => screen.getByRole('button', { name })

describe('useSingleSelect, pressed buttons', () => {
  it('presses a clicked button and releases the others, and says so', async () => {
    const user = userEvent.setup()
    renderGroup()
    expect(button('Table 1')).toHaveAttribute('aria-pressed', 'true')

    await user.click(button('Table 3'))

    expect(button('Table 3')).toHaveAttribute('aria-pressed', 'true')
    expect(button('Table 1')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Table 2')).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByText('Table 3, selected')).toBeInTheDocument()
  })

  it('makes every button a tab stop, and ignores the arrow keys', async () => {
    const user = userEvent.setup()
    renderGroup()

    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(button('Table 1')).toHaveFocus()
    expect(button('Table 1')).toHaveAttribute('aria-pressed', 'true')
    await user.tab()
    expect(button('Table 2')).toHaveFocus()
  })
})
