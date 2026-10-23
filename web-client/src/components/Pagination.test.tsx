import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './Pagination'

// What the row shows, in order: each button's text, the current page in
// brackets, and the gaps.
function row() {
  return Array.from(
    screen.getByRole('navigation').querySelectorAll('.pagination-item'),
  ).map((item) =>
    item.getAttribute('aria-current') === 'page'
      ? `[${item.textContent}]`
      : item.textContent,
  )
}

describe('Pagination', () => {
  it('is a navigation landmark named Pagination', () => {
    render(<Pagination pageCount={12} />)

    expect(
      screen.getByRole('navigation', { name: 'Pagination' }),
    ).toHaveClass('pagination')
  })

  it('starts on the first page unless given one', () => {
    render(<Pagination pageCount={12} />)

    expect(row()).toEqual(['‹', '[1]', '2', '3', '…', '12', '›'])
  })

  it('names its buttons for assistive tech, and hides the gaps', () => {
    render(<Pagination pageCount={12} defaultPage={6} />)

    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Previous page',
      'Page 1',
      'Page 5',
      'Page 6',
      'Page 7',
      'Page 12',
      'Next page',
    ])
    expect(screen.getByRole('button', { name: 'Page 6' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    for (const gap of screen.getAllByText('…')) {
      expect(gap).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('goes to a page when its button is clicked', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(<Pagination pageCount={12} onPageChange={onPageChange} />)

    await user.click(screen.getByRole('button', { name: 'Page 3' }))
    expect(row()).toEqual(['‹', '1', '2', '[3]', '4', '…', '12', '›'])

    await user.click(screen.getByRole('button', { name: 'Page 12' }))
    expect(row()).toEqual(['‹', '1', '…', '10', '11', '[12]', '›'])
    expect(onPageChange.mock.calls).toEqual([[3], [12]])
  })

  it('steps a page at a time with Previous and Next', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(
      <Pagination pageCount={12} defaultPage={6} onPageChange={onPageChange} />,
    )

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(row()).toEqual(['‹', '1', '…', '6', '[7]', '8', '…', '12', '›'])
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(row()).toEqual(['‹', '1', '…', '4', '[5]', '6', '…', '12', '›'])
    expect(onPageChange.mock.calls).toEqual([[7], [6], [5]])
  })

  it('disables Previous on the first page and Next on the last', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(<Pagination pageCount={3} onPageChange={onPageChange} />)
    const previous = screen.getByRole('button', { name: 'Previous page' })
    const next = screen.getByRole('button', { name: 'Next page' })
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    expect(next).toHaveAttribute('aria-disabled', 'false')

    await user.click(previous)
    expect(row()).toEqual(['‹', '[1]', '2', '3', '›'])

    await user.click(screen.getByRole('button', { name: 'Page 3' }))
    expect(previous).toHaveAttribute('aria-disabled', 'false')
    expect(next).toHaveAttribute('aria-disabled', 'true')
    await user.click(next)
    expect(row()).toEqual(['‹', '1', '2', '[3]', '›'])
    expect(onPageChange.mock.calls).toEqual([[3]])
  })

  it('keeps the focus on Next when it reaches the last page', async () => {
    const user = userEvent.setup()
    render(<Pagination pageCount={2} />)
    const next = screen.getByRole('button', { name: 'Next page' })
    next.focus()

    await user.keyboard('{Enter}')

    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(next).toHaveFocus()
  })

  it('does nothing when the current page is clicked', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(<Pagination pageCount={12} onPageChange={onPageChange} />)

    await user.click(screen.getByRole('button', { name: 'Page 1' }))

    expect(row()).toEqual(['‹', '[1]', '2', '3', '…', '12', '›'])
    expect(onPageChange).not.toHaveBeenCalled()
  })
})
