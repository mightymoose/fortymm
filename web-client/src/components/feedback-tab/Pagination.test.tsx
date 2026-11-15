import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Pagination } from './Pagination.tsx'

const page = (n: number) => screen.getByRole('button', { name: `Page ${n}` })

test('pagination is a navigation named by its label, a button per page, the page shown current', () => {
  render(<Pagination label="Results pages" pages={4} defaultPage={2} />)

  expect(
    screen.getByRole('navigation', { name: 'Results pages' }),
  ).toBeVisible()
  expect(screen.getAllByRole('button')).toHaveLength(4)
  expect(page(2)).toHaveAttribute('aria-current', 'page')
  expect(page(1)).not.toHaveAttribute('aria-current')
})

test('choosing a page makes it current, and only it, and tells the listener', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(
    <Pagination
      label="Results pages"
      pages={4}
      defaultPage={2}
      onChange={onChange}
    />,
  )

  await user.click(page(3))

  expect(page(3)).toHaveAttribute('aria-current', 'page')
  expect(page(2)).not.toHaveAttribute('aria-current')
  expect(onChange).toHaveBeenCalledExactlyOnceWith(3)
})
