import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('is hidden from assistive tech', () => {
    const { container } = render(<Skeleton width="60%" height={14} />)

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('takes its width and height', () => {
    const { container } = render(<Skeleton width="60%" height={14} />)

    expect(container.firstElementChild).toHaveStyle({
      width: '60%',
      height: '14px',
    })
  })

  // Each shape's look is only CSS (checked against the reference kit in the
  // Playwright suite), so its class is the only contract jsdom can see.
  it.each([
    ['rect', 'skeleton'],
    ['circle', 'skeleton skeleton--circle'],
  ] as const)('takes the %s shape class', (shape, className) => {
    const { container } = render(
      <Skeleton shape={shape} width={48} height={48} />,
    )

    expect(container.firstElementChild).toHaveClass(className, { exact: true })
  })

  it('is a rect unless given a shape', () => {
    const { container } = render(<Skeleton width="40%" height={12} />)

    expect(container.firstElementChild).toHaveClass('skeleton', {
      exact: true,
    })
  })
})
