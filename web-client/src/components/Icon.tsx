import type { ReactElement } from 'react'

// The design system's Lucide icons, as kit.js draws them
// (references/design-system/ui_kits/components/kit.js).
const paths = {
  check: (
    <>
      <path d="M20 6 9 17l-5-5" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </>
  ),
  chevron: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  offline: (
    <>
      <path d="M12 20h.01" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /><path d="M5 12.859a10 10 0 0 1 5.17-2.69" /><path d="M19 12.859a10 10 0 0 0-2.007-1.523" /><path d="M2 8.82a15 15 0 0 1 4.177-2.643" /><path d="M22 8.82a15 15 0 0 0-11.288-3.764" /><path d="m2 2 20 20" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" /><path d="M12 5v14" />
    </>
  ),
  minus: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  map: (
    <>
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="1" /><path d="M12 5v12" /><path d="M8 21l1-4" /><path d="M16 21l-1-4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
    </>
  ),
  left: (
    <>
      <path d="m15 18-6-6 6-6" />
    </>
  ),
  right: (
    <>
      <path d="m9 18 6-6-6-6" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
    </>
  ),
  // Lucide's "arrow-left", which kit.js doesn't draw, for a Back button.
  back: (
    <>
      <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
    </>
  ),
  // Lucide's "menu" and "house", which kit.js doesn't draw, for
  // the app's sidebar.
  menu: (
    <>
      <path d="M4 12h16" /><path d="M4 6h16" /><path d="M4 18h16" />
    </>
  ),
  house: (
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
} satisfies Record<string, ReactElement>

export type IconName = keyof typeof paths

// An icon as kit.js's `data-icon` draws it, styled by `.fm-ic` in
// styles/kit.css. It's decorative: the control it sits in names it.
export function Icon({
  name,
  className,
}: {
  name: IconName
  className?: string
}) {
  return (
    <span className={className ? `fm-ic ${className}` : 'fm-ic'} aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {paths[name]}
      </svg>
    </span>
  )
}
