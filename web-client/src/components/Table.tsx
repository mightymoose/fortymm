import type { ReactNode } from 'react'

export type Column<Row> = {
  header: string
  // Numbers line up in mono, tabular figures, right-aligned, under a header
  // aligned the same way.
  numeric?: boolean
  cell: (row: Row) => ReactNode
}

// Rows of data under a header per column, styled by `.table` in
// styles/base.css. It scrolls sideways inside its container when it's wider
// than the screen, rather than widening the page.
export function Table<Row>({
  label,
  columns,
  rows,
  rowKey,
}: {
  label: string
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
}) {
  return (
    <div className="table-scroll">
      <table className="table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                className={column.numeric ? 'table-num' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={column.numeric ? 'table-num' : undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
