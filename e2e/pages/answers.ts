import type { APIResponse } from '@playwright/test'

// The page every unknown path gets, recognised by the element the app mounts
// in (web-client/index.html).
export async function isTheAppPage(response: APIResponse): Promise<boolean> {
  return (await response.text()).includes('<div id="root">')
}

// What api-echo (dev/api-echo/server.mjs), the stand-in for the api, received,
// or null if the answer isn't api-echo's.
export interface Echo {
  method: string
  url: string
  headers: Record<string, string>
  body: Buffer
}

export async function echoOf(response: APIResponse): Promise<Echo | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { echo?: unknown }).echo !== 'api-echo'
  ) {
    return null
  }
  const echo = parsed as Omit<Echo, 'body'> & { body: string }
  return { ...echo, body: Buffer.from(echo.body, 'base64') }
}
