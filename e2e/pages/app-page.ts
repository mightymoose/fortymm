import type { APIResponse } from '@playwright/test'

// Whether a response is the web client's page, which the hosting gives every
// unknown path: recognised by the element the app mounts in
// (web-client/index.html), or, for a HEAD, which has no body, by its HTML
// content type.
export async function isTheAppPage(response: APIResponse): Promise<boolean> {
  const type = response.headers()['content-type'] ?? ''
  return (
    type.startsWith('text/html') ||
    (await response.text()).includes('<div id="root">')
  )
}

// The methods a page or a script can send. Only GET and HEAD ever get the
// app's page, but /api/* must never be it, whatever the method.
export const methods = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const
