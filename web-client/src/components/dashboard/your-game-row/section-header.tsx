import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { C, UI } from '@/components/dashboard/dashboard-tokens'

export interface SectionHeaderProps {
  title: string
  subtitle?: string
  action?: string
  actionTo?: string
  actionSearch?: Record<string, string | undefined>
}

/** The title row above a dashboard section — a heading, an optional muted
 * subtitle, and an optional right-aligned "see more" link (rendered only when
 * both an action label and its target route are supplied). */
export const SectionHeader = ({
  title,
  subtitle,
  action,
  actionTo,
  actionSearch,
}: SectionHeaderProps) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      marginBottom: 14,
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <h2
      style={{
        margin: 0,
        font: `600 18px ${UI}`,
        color: C.chalk50,
        letterSpacing: '-0.005em',
      }}
    >
      {title}
    </h2>
    {subtitle && (
      <span style={{ font: `400 13px ${UI}`, color: C.chalk500 }}>{subtitle}</span>
    )}
    <div style={{ flex: 1 }} />
    {action && actionTo && (
      <Link
        to={actionTo}
        search={actionSearch}
        style={{
          font: `500 13px ${UI}`,
          color: C.chalk300,
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {action}
        <ChevronRight size={12} strokeWidth={1.75} />
      </Link>
    )}
  </div>
)
