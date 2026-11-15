import type { ReactNode } from 'react'
import './Tooltip.css'

// The design system's tooltip (.fm-tooltip): supplementary text for the
// control it describes, never something only it says. role="tooltip", with
// an `id` for the control to point at (aria-describedby). Drawn in place
// (the kit's .fm-tooltip--static), as the design system page shows it;
// showing it on hover and focus is the screen's to add when one needs it.
export function Tooltip({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} role="tooltip" className="tooltip">
      {children}
    </span>
  )
}
