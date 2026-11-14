import { useId, type ReactNode } from 'react'
import './Dialog.css'

// The design system's dialog (.fm-dialog): a question that needs an answer
// before going on ("Withdraw Okafor from Open singles?"), what answering
// means, and the answers, the safe one first. role="dialog", named by its
// title and described by its text. Drawn in place, as the design system
// page shows it (the kit's static dialog, no backdrop); opening it over a
// screen, and where focus goes, is the screen's to add when one needs it.
export function Dialog({
  title,
  children,
  actions,
}: {
  title: string
  children: ReactNode
  actions: ReactNode
}) {
  const id = useId()
  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-text`}
      className="dialog"
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-text`}>{children}</p>
      <div className="dialog__actions">{actions}</div>
    </div>
  )
}
