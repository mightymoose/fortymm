import { useLocation } from '@tanstack/react-router'

// The link that signs the visitor in and brings them back to this page. It's
// a full page load, not a router link: the API answers with a 302 to the
// identity provider, and the browser must follow it.
export function useSignInHref(): string {
  const { pathname, searchStr } = useLocation()
  return `/api/v1/auth/login?return_to=${encodeURIComponent(pathname + searchStr)}`
}
