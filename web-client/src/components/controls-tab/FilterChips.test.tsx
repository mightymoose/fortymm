import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { FilterChips } from './FilterChips.tsx'

function renderEvents(
  defaultOn: string[] = [],
  onChange?: (on: string[]) => void,
) {
  render(
    <FilterChips
      label="Events"
      allLabel="All events"
      defaultOn={defaultOn}
      onChange={onChange}
      options={[
        { value: 'open-singles', label: 'Open singles' },
        { value: 'doubles', label: 'Doubles' },
        { value: 'u-2000', label: 'U-2000' },
      ]}
    />,
  )
}

const chip = (name: string) => screen.getByRole('button', { name })

test('pressing a chip turns its filter on, and pressing it again turns it off', async () => {
  const user = userEvent.setup()
  renderEvents()

  await user.click(chip('Doubles'))
  expect(chip('Doubles')).toHaveAttribute('aria-pressed', 'true')

  await user.click(chip('Doubles'))
  expect(chip('Doubles')).toHaveAttribute('aria-pressed', 'false')
})

test('several chips can be on, and the listener hears which, in the chips’ order', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderEvents([], onChange)

  await user.click(chip('U-2000'))
  await user.click(chip('Open singles'))

  expect(chip('U-2000')).toHaveAttribute('aria-pressed', 'true')
  expect(chip('Open singles')).toHaveAttribute('aria-pressed', 'true')
  expect(onChange).toHaveBeenLastCalledWith(['open-singles', 'u-2000'])
})

test('“All events” is on exactly when no other chip is', async () => {
  const user = userEvent.setup()
  renderEvents()
  expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')

  await user.click(chip('Doubles'))
  expect(chip('All events')).toHaveAttribute('aria-pressed', 'false')

  await user.click(chip('Doubles'))
  expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')
})

test('pressing “All events” turns every other chip off', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderEvents(['open-singles', 'doubles'], onChange)

  await user.click(chip('All events'))

  expect(chip('Open singles')).toHaveAttribute('aria-pressed', 'false')
  expect(chip('Doubles')).toHaveAttribute('aria-pressed', 'false')
  expect(chip('All events')).toHaveAttribute('aria-pressed', 'true')
  expect(onChange).toHaveBeenCalledExactlyOnceWith([])
})

test('the chips are a named group', () => {
  renderEvents()

  expect(screen.getByRole('group', { name: 'Events' })).toBeVisible()
})
