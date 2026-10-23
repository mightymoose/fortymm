import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type Column, Table } from './Table'

type Player = { name: string; club: string; rating: number }

const columns: Column<Player>[] = [
  { header: 'Player', cell: (player) => player.name },
  { header: 'Club', cell: (player) => player.club },
  { header: 'Rating', numeric: true, cell: (player) => player.rating },
]

const players: Player[] = [
  { name: 'Nguyen, Tien', club: 'Brooklyn TT', rating: 1620 },
  { name: 'Okafor, Daniel', club: 'NYC Open Hall', rating: 1582 },
]

function renderTable() {
  render(
    <Table
      label="Standings"
      columns={columns}
      rows={players}
      rowKey={(player) => player.name}
    />,
  )
}

describe('Table', () => {
  it('is a table named by its label', () => {
    renderTable()

    expect(screen.getByRole('table', { name: 'Standings' })).toBeVisible()
  })

  it('has a column header per column, in order', () => {
    renderTable()

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent),
    ).toEqual(['Player', 'Club', 'Rating'])
  })

  it("shows each row's cells under the columns, in order", () => {
    renderTable()

    const [, ...bodyRows] = screen.getAllByRole('row')
    expect(
      bodyRows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['Nguyen, Tien', 'Brooklyn TT', '1620'],
      ['Okafor, Daniel', 'NYC Open Hall', '1582'],
    ])
  })

  // A numeric column's look is only CSS (checked against the reference kit
  // in the Playwright suite), so its class is the only contract jsdom can
  // see. The header takes it too, so it lines up with its numbers.
  it("marks a numeric column's header and cells", () => {
    renderTable()

    expect(screen.getByRole('columnheader', { name: 'Rating' })).toHaveClass(
      'table-num',
    )
    expect(screen.getByRole('cell', { name: '1620' })).toHaveClass('table-num')
    expect(
      screen.getByRole('columnheader', { name: 'Club' }),
    ).not.toHaveClass('table-num')
    expect(screen.getByRole('cell', { name: 'Brooklyn TT' })).not.toHaveClass(
      'table-num',
    )
  })
})
