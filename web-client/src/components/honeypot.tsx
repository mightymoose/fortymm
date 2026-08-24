import { useId } from 'react'

import { HONEYPOT_STYLE } from '@/lib/form-helpers'

export interface HoneypotProps {
  value: string
  onChange: (value: string) => void
  testId: string
}

// The bot trap shared by every email form. It must stay real, parseable DOM —
// never `display: none`, `visibility: hidden` or the `hidden` attribute, because
// bots fill every field they can parse and that is the whole trap. Humans get
// complete hiding instead: off-screen positioning plus `inert` next to
// `aria-hidden="true"` takes it out of the focus order and the accessibility
// tree together (a focusable input inside an aria-hidden wrapper is an ARIA
// authoring violation). The DOM `id`/`name` derive from `useId()` so heuristic
// autofill cannot target a fixed name; the wire payload never sees this name —
// callers post their own state as `fmm_hp_token`. The label copy stays
// parseable on purpose.
export const Honeypot = ({ value, onChange, testId }: HoneypotProps) => {
  const id = useId()

  return (
    <div style={HONEYPOT_STYLE} aria-hidden="true" inert>
      <label htmlFor={id}>Leave this empty</label>
      <input
        id={id}
        name={id}
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </div>
  )
}
