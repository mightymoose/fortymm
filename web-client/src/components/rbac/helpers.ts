import { format, formatDistanceToNowStrict } from 'date-fns'
import type { Permission } from './seed'

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

// Stable order for known resource prefixes; unknown prefixes sort to the end alphabetically.
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
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    })
    .map(([prefix, items]) => ({ prefix, items }))
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(new Date(iso), 'MMM d, yyyy')
}

export function fmtDateRel(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
}

export const newId = (prefix: string) =>
  prefix + '_' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10))

export const nowIso = () => new Date().toISOString()

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

const AVATAR_PALETTE: Array<[string, string]> = [
  ['#FF7A1A', '#fff'],
  ['#00E29A', '#0B0D12'],
  ['#6FB5FF', '#0B0D12'],
  ['#FFC43D', '#0B0D12'],
  ['#FF4D6D', '#fff'],
  ['#A87BFF', '#fff'],
]

export function avatarColorsFor(name: string): [string, string] {
  return AVATAR_PALETTE[hash(name) % AVATAR_PALETTE.length]
}
