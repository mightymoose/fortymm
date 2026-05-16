import { format, formatDistanceToNowStrict } from 'date-fns'
import type { Permission } from './queries'

const ROLE_PALETTE = ['#FF7A1A', '#00E29A', '#6FB5FF', '#FFC43D', '#A87BFF', '#FF4D6D', '#8CFFD4']

function hash(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

export function colorFor(name: string): string {
  return ROLE_PALETTE[hash(name) % ROLE_PALETTE.length]
}

export function permPrefix(name: string): string {
  const dot = name.indexOf('.')
  return dot === -1 ? 'other' : name.slice(0, dot)
}

const PREFIX_ORDER = ['tournament', 'draws', 'courts', 'players', 'ratings', 'members', 'roles', 'permissions', 'system', 'other']

export function groupPermissions(perms: Permission[]): Array<{ prefix: string; items: Permission[] }> {
  const groups = new Map<string, Permission[]>()
  for (const p of perms) {
    const k = permPrefix(p.name)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(p)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ai = PREFIX_ORDER.indexOf(a)
      const bi = PREFIX_ORDER.indexOf(b)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.localeCompare(b)
    })
    .map(([prefix, items]) => ({ prefix, items }))
}

const TZ_DESIGNATOR_RE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Parses an ISO timestamp from the API. The API emits UTC timestamps, but some
 * arrive without an explicit zone designator — `new Date()` then parses them in
 * the browser's local zone, which drifts "just now" hours into the past or
 * future (e.g. "in 5 hours"). Treat a designator-less datetime as UTC.
 */
function parseApiDate(iso: string): Date {
  const needsUtc = iso.includes('T') && !TZ_DESIGNATOR_RE.test(iso)
  return new Date(needsUtc ? `${iso}Z` : iso)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseApiDate(iso), 'MMM d, yyyy')
}

export function fmtDateRel(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatDistanceToNowStrict(parseApiDate(iso), { addSuffix: true })
}

export function initialsFor(name: string): string {
  return name
    .replace(/[._-]/g, ' ')
    .split(/\s+/)
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// Same cardinality as ROLE_PALETTE (7) so name → bucket maps consistently
// between role pill colors and user avatars.
const AVATAR_PALETTE: Array<[string, string]> = [
  ['#FF7A1A', '#fff'],
  ['#00E29A', '#0B0D12'],
  ['#6FB5FF', '#0B0D12'],
  ['#FFC43D', '#0B0D12'],
  ['#A87BFF', '#fff'],
  ['#FF4D6D', '#fff'],
  ['#8CFFD4', '#0B0D12'],
]

export function avatarColorsFor(name: string): [string, string] {
  return AVATAR_PALETTE[hash(name) % AVATAR_PALETTE.length]
}
