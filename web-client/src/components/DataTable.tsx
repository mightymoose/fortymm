import type { ReactNode } from 'react'
import './DataTable.css'

export type Column = {
  key: string
  label: string
  // Numbers: in figures, right-aligned.
  numeric?: boolean
}

export type Row = {
  id: string
  cells: Record<string, ReactNode>
}

// The design system's data table (.fm-table): rows of things with the same
// facts, a column each. A real <table> named by `label`, each column's
// header a <th scope="col">; numeric columns in figures, right-aligned.
export function DataTable({
  label,
  columns,
  rows,
}: {
  label: string
  columns: Column[]
  rows: Row[]
}) {
  const numeric = (column: Column) => (column.numeric ? 'n' : undefined)
  return (
    <table className="data-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col" className={numeric(column)}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            {columns.map((column) => (
              <td key={column.key} className={numeric(column)}>
                {row.cells[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
