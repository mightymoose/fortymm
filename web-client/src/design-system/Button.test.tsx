import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { Button } from './Button.tsx'

describe('Button', () => {
  it('calls onPress when pressed', async ({ user }) => {
    const onPress = vi.fn()
    render(<Button onPress={onPress}>Call to table</Button>)
    await user.click(screen.getByRole('button', { name: 'Call to table' }))
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('is named by its aria-label when icon-only', () => {
    render(
      <Button isIconOnly aria-label="Close">
        ×
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  describe('pending', () => {
    it('is busy', () => {
      render(<Button isPending>Saving…</Button>)
      expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true')
    })

    it('is not marked disabled, so it keeps its colours', () => {
      render(<Button isPending>Saving…</Button>)
      expect(screen.getByRole('button', { name: 'Saving…' })).not.toHaveAttribute('aria-disabled')
    })

    it('ignores presses', async ({ user }) => {
      const onPress = vi.fn()
      render(
        <Button isPending onPress={onPress}>
          Saving…
        </Button>,
      )
      await user.click(screen.getByRole('button', { name: 'Saving…' }))
      expect(onPress).not.toHaveBeenCalled()
    })
  })

  describe('disabled', () => {
    it('is disabled', () => {
      render(<Button isDisabled>Call to table</Button>)
      expect(screen.getByRole('button', { name: 'Call to table' })).toBeDisabled()
    })

    it('ignores presses', async ({ user }) => {
      const onPress = vi.fn()
      render(
        <Button isDisabled onPress={onPress}>
          Call to table
        </Button>,
      )
      await user.click(screen.getByRole('button', { name: 'Call to table' }))
      expect(onPress).not.toHaveBeenCalled()
    })
  })

  describe('disabled with a reason', () => {
    function renderStartMatch(onPress?: () => void) {
      render(
        <>
          <Button isDisabled disabledReason="why" onPress={onPress}>
            Start match
          </Button>
          <p id="why">Both players need to check in first.</p>
        </>,
      )
      return screen.getByRole('button', { name: 'Start match' })
    }

    it('is marked disabled', () => {
      expect(renderStartMatch()).toHaveAttribute('aria-disabled', 'true')
    })

    it('is described by its reason', () => {
      expect(renderStartMatch()).toHaveAccessibleDescription('Both players need to check in first.')
    })

    it('can still be focused, so the reason is read out', async ({ user }) => {
      const button = renderStartMatch()
      await user.tab()
      expect(button).toHaveFocus()
    })

    it('ignores presses', async ({ user }) => {
      const onPress = vi.fn()
      await user.click(renderStartMatch(onPress))
      expect(onPress).not.toHaveBeenCalled()
    })
  })
})
