import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from '../Button.tsx'
import { Tooltip } from './Tooltip.tsx'

test('a tooltip is a tooltip, and describes the control that points at it', () => {
  render(
    <>
      <Tooltip id="match-tooltip">Nguyen, Thanh vs Okafor, Daniel</Tooltip>
      <Button variant="secondary" aria-describedby="match-tooltip">
        Okafor · Nguyen
      </Button>
    </>,
  )

  expect(screen.getByRole('tooltip')).toHaveTextContent(
    'Nguyen, Thanh vs Okafor, Daniel',
  )
  expect(
    screen.getByRole('button', { name: 'Okafor · Nguyen' }),
  ).toHaveAccessibleDescription('Nguyen, Thanh vs Okafor, Daniel')
})
