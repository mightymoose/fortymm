import { Link as AriaLink, type LinkProps } from 'react-aria-components'
import { type ButtonVariant } from './Button.tsx'

// React Aria's Link drawn as kit.css's link button (fm-btn--link), or, with a variant, as a button
// of that variant, for navigation that is a card's action (e.g. "Open scoring"). Unrouted: use
// ButtonLink, which is this wired to TanStack Router.
export function AriaButtonLink({ variant, ...props }: LinkProps & { variant?: ButtonVariant }) {
  return <AriaLink {...props} className={`fm-btn fm-btn--${variant ?? 'link'}`} />
}
