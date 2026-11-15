import './Kbd.css'

// The design system's keyboard hint (.fm-kbd): a key to press, as a small
// keycap in figures. A real <kbd>.
export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>
}
