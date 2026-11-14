import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { DescriptionList } from './DescriptionList.tsx'

test('a details list pairs each label with its value', () => {
  render(
    <DescriptionList
      items={[
        { term: 'Table', detail: '3' },
        { term: 'Started', detail: '11:20', numeric: true },
      ]}
    />,
  )

  expect(
    screen.getAllByRole('term').map((term) => term.textContent),
  ).toEqual(['Table', 'Started'])
  expect(
    screen.getAllByRole('definition').map((value) => value.textContent),
  ).toEqual(['3', '11:20'])
})
