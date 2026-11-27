import { createLink } from '@tanstack/react-router'
import { AriaButtonLink } from './AriaButtonLink.tsx'

// A link drawn as a link button (fm-btn--link): for navigation that sits in a row of buttons, e.g.
// "View draw". Takes `to` like TanStack Router's own Link.
export const ButtonLink = createLink(AriaButtonLink)
