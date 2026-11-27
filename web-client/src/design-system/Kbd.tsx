// A keyboard shortcut shown inside a control, e.g. ⌘K on a Search button. Decoration: the control's
// own label names the action, so the hint is hidden from assistive technology.
export function Kbd({ children }: { children: string }) {
  return (
    <span className="fm-kbd" aria-hidden="true">
      {children}
    </span>
  )
}
