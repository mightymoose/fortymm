import { type ReactNode } from 'react'

// A row of the Foundations board's type scale: the style's label beside a sample set in it.
export function TypeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ty">
      <span>{label}</span>
      {children}
    </div>
  )
}
