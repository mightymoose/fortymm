import { type ReactNode } from 'react'

// A set of related choices under a legend (fm-choices), stacked: e.g. independent checkboxes that
// each turn one setting on or off. For pick-one choices, use a RadioGroup.
export function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="fm-choices">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  )
}
