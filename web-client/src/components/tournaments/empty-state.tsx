import type { ReactNode } from 'react'

export interface EmptyStateProps {
  /** Optional icon (rendered at 28px in the design); omit for a text-only state. */
  icon?: ReactNode
  title: string
  hint?: ReactNode
  /** Optional call-to-action, e.g. a `<Button>`. */
  action?: ReactNode
}

/** The dashed-border "nothing here yet" panel shared across the tournament
 * list, the detail tabs, and the event-editor sections. */
export const EmptyState = ({ icon, title, hint, action }: EmptyStateProps) => {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-[color:var(--border-default)] bg-[color:var(--bg-card)] px-6 py-12 text-center">
      {icon && <div className="text-[color:var(--fg-3)]">{icon}</div>}
      <div className="text-[17px] font-semibold text-[color:var(--fg-1)]">
        {title}
      </div>
      {hint && (
        <p className="max-w-[320px] text-[13px] text-[color:var(--fg-3)]">
          {hint}
        </p>
      )}
      {action}
    </div>
  )
}
