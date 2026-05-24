import type { CSSProperties } from 'react'
import { User as UserIcon } from 'lucide-react'

import { cn, initialsOf } from '@/lib/utils'

function hueFor(name: string): number {
  let hue = 0
  for (let i = 0; i < name.length; i += 1) {
    hue = (hue * 31 + name.charCodeAt(i)) % 360
  }
  return hue
}

// `initialsOf` returns '' for empty input and the literal ellipsis for '…' —
// neither reads as a name. Coerce those to a stable '?' so transient/empty
// states render a recognizable placeholder rather than a blank circle.
function monogram(name: string): string {
  const out = initialsOf(name).replace(/[^A-Z0-9]/gi, '')
  return out || '?'
}

export interface UserAvatarProps {
  /** Username. `null` renders the dashed-circle "no opponent" placeholder. */
  name: string | null
  /** Pixel diameter. */
  size?: number
  /** Outer ring (e.g. score-needed hero). */
  ring?: boolean
  /** Ring color when `ring` is true. Defaults to `--ball-500`. */
  ringColor?: string
  /** Neutral muted background instead of the per-user color — for non-claimed
   *  or preview states where the username isn't a real identity yet. */
  dim?: boolean
  className?: string
  style?: CSSProperties
}

export function UserAvatar({
  name,
  size = 32,
  ring = false,
  ringColor = 'var(--ball-500)',
  dim = false,
  className,
  style,
}: UserAvatarProps) {
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    fontSize: Math.round(size * 0.4),
    letterSpacing: '0.02em',
    boxShadow: ring
      ? `0 0 0 2px var(--ink-950), 0 0 0 ${size > 40 ? 3 : 2.5}px ${ringColor}`
      : undefined,
  }

  if (name === null) {
    return (
      <span
        aria-hidden="true"
        className={cn('user-avatar user-avatar--ghost', className)}
        style={{
          ...base,
          background: 'transparent',
          border: '1.5px dashed var(--ink-500)',
          color: 'var(--fg-3)',
          ...style,
        }}
      >
        <UserIcon size={Math.round(size * 0.45)} strokeWidth={1.75} />
      </span>
    )
  }

  if (dim) {
    return (
      <span
        role="img"
        aria-label={name}
        className={cn('user-avatar user-avatar--dim', className)}
        style={{
          ...base,
          background: 'var(--ink-700)',
          color: 'var(--fg-3)',
          ...style,
        }}
      >
        {monogram(name)}
      </span>
    )
  }

  const hue = hueFor(name)
  return (
    <span
      role="img"
      aria-label={name}
      className={cn('user-avatar', className)}
      style={{
        ...base,
        background: `hsl(${hue}, 28%, 28%)`,
        color: `hsl(${hue}, 60%, 78%)`,
        ...style,
      }}
    >
      {monogram(name)}
    </span>
  )
}
