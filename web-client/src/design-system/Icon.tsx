import { type ReactNode } from 'react'

// The design system's icons: Lucide, drawn by kit.css's .fm-ic (20px, stroke 1.75, currentColor).
// Paths are copied from the reference boards (requirements/design-system/reference/), not taken from
// the lucide-react package, so they can't drift from the reference between Lucide versions. Names
// are Lucide's: to add one, copy its path data from lucide.dev.
const icons = {
  'info': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  'clock': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  'check': (
    <path d="M20 6 9 17l-5-5" />
  ),
  'triangle-alert': (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  'circle-alert': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  'wifi-off': (
    <>
      <path d="M12 20h.01" />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
      <path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
      <path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
      <path d="M2 8.82a15 15 0 0 1 4.177-2.643" />
      <path d="M22 8.82a15 15 0 0 0-11.288-3.764" />
      <path d="m2 2 20 20" />
    </>
  ),
  'calendar': (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  'undo-2': (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </>
  ),
  'list': (
    <>
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
    </>
  ),
  'table': (
    <>
      <path d="M12 3v18" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18" />
      <path d="M3 15h18" />
    </>
  ),
  'search': (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  'ellipsis': (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  'x': (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  'chevron-down': (
    <path d="m6 9 6 6 6-6" />
  ),
  'chevron-left': (
    <path d="m15 18-6-6 6-6" />
  ),
  'chevron-right': (
    <path d="m9 18 6-6-6-6" />
  ),
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof icons

// An icon. With a label it is an image with that name; without, it is decoration, hidden from
// assistive technology. Small icons (16px) are for dense rows and small buttons.
export function Icon({ name, label, size }: { name: IconName; label?: string; size?: 'sm' }) {
  const className = size === 'sm' ? 'fm-ic fm-ic--sm' : 'fm-ic'
  if (label) {
    return (
      <span className={className} role="img" aria-label={label}>
        <svg viewBox="0 0 24 24">{icons[name]}</svg>
      </span>
    )
  }
  return (
    <span className={className}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {icons[name]}
      </svg>
    </span>
  )
}
