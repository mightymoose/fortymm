// Shared style tokens for the dashboard quartets. The dashboard renders a
// bespoke dark "scoreboard" surface that predates most of the design system, so
// its components reach for these raw CSS custom properties rather than the
// shadcn primitives. Centralized here as the lowest common ancestor of every
// dashboard component that paints with them.

export const C = {
  ink950: 'var(--ink-950)',
  ink900: 'var(--ink-900)',
  ink800: 'var(--ink-800)',
  ink700: 'var(--ink-700)',
  ink600: 'var(--ink-600)',
  ink500: 'var(--ink-500)',
  chalk50: 'var(--chalk-50)',
  chalk100: 'var(--chalk-100)',
  chalk300: 'var(--chalk-300)',
  chalk500: 'var(--chalk-500)',
  ball400: 'var(--ball-400)',
  ball500: 'var(--ball-500)',
  serve500: 'var(--serve-500)',
  warn: 'var(--warn)',
  loss: 'var(--loss)',
}

export const UI = "'Space Grotesk', ui-sans-serif, system-ui, sans-serif"
export const MONO = "'JetBrains Mono', ui-monospace, monospace"
