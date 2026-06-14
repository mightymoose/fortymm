import type { ReactNode } from 'react'

export interface SectionHeaderProps {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
}

/** An accent overline title with an optional subtitle and a right-aligned
 * action — the header used atop each detail tab and editor section. */
export const SectionHeader = ({ title, subtitle, action }: SectionHeaderProps) => {
  return (
    <div className="mb-3 flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold tracking-[0.16em] text-[color:var(--ball-500)] uppercase">
          {title}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[13px] text-[color:var(--fg-3)]">
            {subtitle}
          </div>
        )}
      </div>
      {action}
    </div>
  )
}
