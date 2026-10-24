import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('runs onClick on a click', async () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" onClick={onClick}>
        Call to table
      </Button>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Call to table' }))

    expect(onClick).toHaveBeenCalledOnce()
  })

  it('ignores clicks with aria-disabled, but keeps the focus', async () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" aria-disabled="true" onClick={onClick}>
        Start match
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Start match' })

    await userEvent.click(button)

    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })
})
