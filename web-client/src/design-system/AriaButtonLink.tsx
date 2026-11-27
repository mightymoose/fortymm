import { Link as AriaLink, type LinkProps } from 'react-aria-components'

// React Aria's Link drawn as kit.css's link button (fm-btn--link). Unrouted: use ButtonLink, which
// is this wired to TanStack Router.
export function AriaButtonLink(props: LinkProps) {
  return <AriaLink {...props} className="fm-btn fm-btn--link" />
}
