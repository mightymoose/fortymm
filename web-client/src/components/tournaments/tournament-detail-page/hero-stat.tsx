import type { ReactNode } from 'react'

import { Card } from '@/components/ui/card'

export interface HeroStatProps {
  label: string
  /** The primary figure; a string so callers can pass an em-dash placeholder. */
  value: ReactNode
  icon: ReactNode
  /** Optional trailing unit, e.g. "days". */
  suffix?: string
}

/** One cell of the tournament-detail stat strip: an accent icon chip beside a
 * mono figure and an uppercase label. */
export const HeroStat = ({ label, value, icon, suffix }: HeroStatProps) => {
  return (
    <Card className="flex-row items-center gap-3 px-4">
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="font-mono text-[20px] leading-none font-bold tabular-nums text-[color:var(--fg-1)]">
          {value}
          {suffix && (
            <span className="ml-1 text-[13px] font-medium text-[color:var(--fg-3)]">
              {suffix}
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
          {label}
        </div>
      </div>
    </Card>
  )
}
