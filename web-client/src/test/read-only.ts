// The one sweep every read-only guard test uses (ADR 0015, rule 6): "enforce it
// with a guard test, not with vigilance". A selector copy-pasted into each page
// object is enforced by vigilance — and it forked three ways the first time it
// was written, leaving an `<a href>`-shaped hole in six of the guards. There is
// one definition here, and every page object composes it.

import type { Container } from './utilities'

/** Every interactive element, swept by **DOM**, not by ARIA role — the sweep
 * that actually holds the line. A role sweep silently under-proves: a
 * `type="number"` input is a `spinbutton`, a `type="date"`/`type="time"` input
 * has **no role at all**, and a `ToggleGroupItem` renders `<button role="radio">`
 * (an explicit role overrides the implicit one, so `queryAllByRole('button')`
 * never matches it). A whole live toggle group sails through a role sweep.
 *
 * The list is deliberately a **union**, not the controls a given surface happens
 * to use today: it must catch the control someone adds tomorrow. Hence `a[href]`
 * (a link is a real affordance, and a read-only *view* is not a navigation
 * surface) and `[role="slider"]` (shadcn's `Slider`), neither of which any
 * surface renders yet.
 *
 * `tabindex="-1"` is excluded: it is *not* in the tab order and is not an
 * affordance — Radix puts it on focus guards, scroll containers and tabpanels.
 * Matching it would fail a guard on chrome rather than on a control, and a guard
 * that cries wolf gets loosened, which is how it dies. A genuinely interactive
 * element carrying `tabindex="-1"` is still caught by its tag or its role. */
export const INTERACTIVE_SELECTOR =
  'input, select, textarea, button, a[href], [role="switch"], [role="radio"], [role="slider"], [tabindex]:not([tabindex="-1"]), [contenteditable]'

/** The roles a form control claims in the accessibility tree. Kept only as a
 * *supplement* to the DOM sweep — never instead of it, for the reasons above. */
export const INTERACTIVE_ROLES = [
  'textbox',
  'combobox',
  'switch',
  'button',
  'radio',
  'spinbutton',
] as const

/** Every interactive element under `root`. A read-only surface renders none:
 * a viewer gets a rendering of the data, never a disabled editor. */
export const interactiveElementsIn = (root: HTMLElement): Element[] =>
  Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))

/** The role-swept supplement to `interactiveElementsIn`. */
export const interactiveControlsIn = (container: Container): HTMLElement[] =>
  INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
