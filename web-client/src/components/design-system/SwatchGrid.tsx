import { type ReactNode } from 'react'

// A row of colour swatches on the Foundations board: seven equal columns, whatever the count.
export function SwatchGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 16 }}>
      {children}
    </div>
  )
}
