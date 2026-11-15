import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { DataTable } from './DataTable.tsx'

test('a data table is named by its label, a column header per column, each cell under its header', () => {
  render(
    <DataTable
      label="Ratings"
      columns={[
        { key: 'player', label: 'Player' },
        { key: 'rating', label: 'Rating', numeric: true },
      ]}
      rows={[
        { id: 'nguyen', cells: { player: 'Nguyen, Thanh', rating: '2,145' } },
        { id: 'okafor', cells: { player: 'Okafor, Daniel', rating: '2,098' } },
      ]}
    />,
  )

  const table = screen.getByRole('table', { name: 'Ratings' })
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Player', 'Rating'])
  const rows = within(table).getAllByRole('row').slice(1)
  expect(
    rows.map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ),
  ).toEqual([
    ['Nguyen, Thanh', '2,145'],
    ['Okafor, Daniel', '2,098'],
  ])
})

test('a column header heads its column', () => {
  render(
    <DataTable
      label="Ratings"
      columns={[{ key: 'player', label: 'Player' }]}
      rows={[]}
    />,
  )

  expect(screen.getByRole('columnheader', { name: 'Player' })).toHaveAttribute(
    'scope',
    'col',
  )
})
