import './Icon.css'

// The design system's icons are Lucide's, at stroke 1.75: 20px, or 16px in
// dense places. Only the ones the app uses are here, drawn inline so they
// need no file and no font. An icon is decoration: whatever it sits in names
// itself (an icon-only button carries an aria-label).
const paths = {
  // Lucide "circle-alert", beside a field's error.
  'circle-alert': (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  // Lucide "ellipsis": more actions.
  ellipsis: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
}

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 'md',
}: {
  name: IconName
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={size === 'sm' ? 'icon icon--sm' : 'icon'}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24">{paths[name]}</svg>
    </span>
  )
}
