import { type CSSProperties, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { avatarColorsFor, initialsFor } from './helpers'

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const [bg, fg] = avatarColorsFor(name)
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-ui)',
        fontWeight: 700,
        fontSize: size * 0.4,
        flexShrink: 0,
        letterSpacing: 0.02,
      }}
    >
      {initialsFor(name)}
    </div>
  )
}

type StatVariant = 'card' | 'inline'
type StatTone = 'default' | 'live' | 'warn'

export function Stat({
  label,
  value,
  variant = 'inline',
  tone = 'default',
  mono,
}: {
  label: string
  value: string | number
  variant?: StatVariant
  tone?: StatTone
  mono?: boolean
}) {
  const toneColor =
    tone === 'live' ? 'var(--serve-500)' : tone === 'warn' ? 'var(--warn)' : 'var(--fg-1)'
  const isCard = variant === 'card'
  const wrapper: CSSProperties = isCard
    ? {
        padding: '14px 16px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-md, 10px)',
      }
    : {}
  return (
    <div style={wrapper}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.14em',
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          marginBottom: isCard ? 4 : 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: isCard ? 26 : 13,
          fontWeight: isCard ? 700 : 600,
          color: toneColor,
          fontFamily: mono || isCard ? 'var(--font-mono)' : 'var(--font-ui)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: isCard ? 1.1 : undefined,
        }}
      >
        {value}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  hintTone = 'neutral',
  children,
}: {
  label: string
  hint?: string | null
  hintTone?: 'neutral' | 'loss'
  children: ReactNode
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2)', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && (
        <div
          style={{
            fontSize: 11,
            marginTop: 6,
            color: hintTone === 'loss' ? 'var(--loss)' : 'var(--fg-3)',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  )
}

export function EmptyState({
  icon: IconComponent,
  title,
  body,
}: {
  icon: LucideIcon
  title: string
  body: string
}) {
  return (
    <div
      style={{
        padding: '48px 24px',
        textAlign: 'center',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 'var(--r-md, 10px)',
        background: 'var(--bg-card)',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          padding: 14,
          background: 'var(--ink-900)',
          borderRadius: 999,
          marginBottom: 14,
        }}
      >
        <IconComponent size={22} color="var(--fg-muted)" strokeWidth={1.75} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--fg-3)', maxWidth: 360, margin: '0 auto 16px' }}>{body}</div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 6,
        flexWrap: 'wrap',
        gap: 12,
      }}
    >
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{title}</h1>
        {subtitle && (
          <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: '6px 0 0', maxWidth: 620 }}>{subtitle}</p>
        )}
      </div>
      {action && <div style={{ display: 'flex', gap: 8 }}>{action}</div>}
    </div>
  )
}

export function StatsGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, margin: '24px 0 20px' }}>
      {children}
    </div>
  )
}
