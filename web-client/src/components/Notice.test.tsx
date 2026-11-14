import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Notice } from './Notice.tsx'

test('a notice is a paragraph of its sentence, its icon hidden', () => {
  const { container } = render(
    <Notice tone="success">All 24 players checked in.</Notice>,
  )

  expect(container.querySelector('p')).toHaveTextContent(
    'All 24 players checked in.',
  )
  expect(container.querySelector('svg')?.closest('[aria-hidden]')).not.toBeNull()
})
