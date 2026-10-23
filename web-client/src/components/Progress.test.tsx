import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Progress } from './Progress'

describe('Progress', () => {
  it('is a progress bar named by its label', () => {
    render(
      <Progress label="Round 1 of 5" value={12} max={16} format="fraction" />,
    )

    expect(
      screen.getByRole('progressbar', { name: 'Round 1 of 5' }),
    ).toBeVisible()
  })

  it('gives assistive tech its value out of its max', () => {
    render(
      <Progress label="Round 1 of 5" value={12} max={16} format="fraction" />,
    )

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuenow', '12')
    expect(bar).toHaveAttribute('aria-valuemax', '16')
  })

  it.each([
    ['fraction', 12, 16, '12 / 16', '12 of 16'],
    ['percent', 25, 100, '25%', '25%'],
    ['percent', 1, 3, '33%', '33%'],
  ] as const)(
    'as a %s, shows %i of %i as %j and reads it as %j',
    (format, value, max, shown, spoken) => {
      render(
        <Progress label="Group B" value={value} max={max} format={format} />,
      )

      expect(screen.getByText(shown)).toHaveAttribute('aria-hidden', 'true')
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuetext',
        spoken,
      )
    },
  )

  // The fill's width is the one part of the bar's look jsdom can see.
  it('fills the bar to its value over its max', () => {
    render(
      <Progress label="Round 1 of 5" value={12} max={16} format="fraction" />,
    )

    expect(
      screen.getByRole('progressbar').querySelector('.progress-bar'),
    ).toHaveStyle({ width: '75%' })
  })
})
