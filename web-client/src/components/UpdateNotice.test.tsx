import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { UpdateNotice } from './UpdateNotice.tsx'

const ignore = () => {}

test('shown, the notice is a status message: read out politely, without taking focus', () => {
  render(<UpdateNotice shown onReload={ignore} onDismiss={ignore} />)

  expect(screen.getByRole('status')).toHaveTextContent(
    'A new version is ready.',
  )
  expect(document.body).toHaveFocus()
})

test('not shown, its status region is there and says nothing, so the notice is read out when it appears', () => {
  render(<UpdateNotice shown={false} onReload={ignore} onDismiss={ignore} />)

  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  expect(screen.queryByRole('button')).toBeNull()
})

test('Reload and Dismiss are buttons, reached by keyboard, and each does its own thing', async () => {
  const user = userEvent.setup()
  const onReload = vi.fn()
  const onDismiss = vi.fn()
  render(<UpdateNotice shown onReload={onReload} onDismiss={onDismiss} />)

  await user.tab()
  expect(screen.getByRole('button', { name: 'Reload' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(onReload).toHaveBeenCalledOnce()
  expect(onDismiss).not.toHaveBeenCalled()

  await user.tab()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(onReload).toHaveBeenCalledOnce()
})
