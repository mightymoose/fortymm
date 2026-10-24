import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_MS, ToastProvider } from './ToastProvider'
import { useToast, type ToastOptions } from './toastContext'

function Raise({ message, options }: { message: string; options?: ToastOptions }) {
  const showToast = useToast()
  return (
    <button type="button" onClick={() => showToast(message, options)}>
      Raise {message}
    </button>
  )
}

function renderWith(...raisers: { message: string; options?: ToastOptions }[]) {
  render(
    <ToastProvider>
      {raisers.map(({ message, options }) => (
        <Raise key={message} message={message} options={options} />
      ))}
    </ToastProvider>,
  )
}

const region = () => screen.getByRole('status', { name: 'Notifications' })

describe('ToastProvider', () => {
  let user: ReturnType<typeof userEvent.setup>

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  })

  afterEach(() => {
    vi.useRealTimers()
    window.history.replaceState(null, '', '/')
  })

  it('shows a raised toast in the region', async () => {
    renderWith({ message: 'Table 4 marked free' })

    await user.click(screen.getByRole('button', { name: 'Raise Table 4 marked free' }))

    expect(within(region()).getByText('Table 4 marked free')).toBeVisible()
  })

  it('takes the toast away after 6 s', async () => {
    renderWith({ message: 'Table 4 marked free' })
    await user.click(screen.getByRole('button', { name: 'Raise Table 4 marked free' }))

    act(() => vi.advanceTimersByTime(TOAST_MS - 100))
    expect(within(region()).getByText('Table 4 marked free')).toBeVisible()
    act(() => vi.advanceTimersByTime(100))

    expect(region()).toBeEmptyDOMElement()
  })

  it('keeps the toast while it is hovered, then gives it 6 s more', async () => {
    renderWith({ message: 'Table 4 marked free' })
    await user.click(screen.getByRole('button', { name: 'Raise Table 4 marked free' }))
    const toast = within(region()).getByText('Table 4 marked free')

    await user.hover(toast)
    act(() => vi.advanceTimersByTime(TOAST_MS * 2))
    expect(toast).toBeVisible()
    await user.unhover(toast)
    act(() => vi.advanceTimersByTime(TOAST_MS))

    expect(region()).toBeEmptyDOMElement()
  })

  it('keeps the toast while focus is in it', async () => {
    renderWith({ message: 'Table 4 marked free' })
    await user.click(screen.getByRole('button', { name: 'Raise Table 4 marked free' }))

    act(() => within(region()).getByRole('button', { name: 'Dismiss' }).focus())
    act(() => vi.advanceTimersByTime(TOAST_MS * 2))

    expect(within(region()).getByText('Table 4 marked free')).toBeVisible()
  })

  it('keeps the toast until it is dismissed in test mode', async () => {
    window.history.replaceState(null, '', '/?test')
    renderWith({ message: 'Table 4 marked free' })
    await user.click(screen.getByRole('button', { name: 'Raise Table 4 marked free' }))

    act(() => vi.advanceTimersByTime(TOAST_MS * 2))
    expect(within(region()).getByText('Table 4 marked free')).toBeVisible()
    await user.click(within(region()).getByRole('button', { name: 'Dismiss' }))

    expect(region()).toBeEmptyDOMElement()
  })

  it('undoes the change and takes the toast away on Undo', async () => {
    const undo = vi.fn()
    renderWith({ message: 'Doubles moved to 12:40', options: { undo } })
    await user.click(screen.getByRole('button', { name: 'Raise Doubles moved to 12:40' }))

    await user.click(within(region()).getByRole('button', { name: 'Undo' }))

    expect(undo).toHaveBeenCalledOnce()
    expect(region()).toBeEmptyDOMElement()
  })

  it('shows at most three toasts, newest last', async () => {
    renderWith(
      { message: 'One' },
      { message: 'Two' },
      { message: 'Three' },
      { message: 'Four' },
    )

    for (const message of ['One', 'Two', 'Three', 'Four']) {
      await user.click(screen.getByRole('button', { name: `Raise ${message}` }))
    }

    expect(region()).toHaveTextContent(/^TwoThreeFour$/)
  })
})
