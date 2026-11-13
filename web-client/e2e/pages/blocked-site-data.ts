import { chromium, type BrowserContext } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fresh Chromium profile that blocks site data, as a person does with
// "Don't allow sites to save data" (the profile setting cookies = 2): the
// page still has WebCrypto, IndexedDB and Web Locks, but storage and lock
// requests are denied. Close it with the function it returns.
export async function blockedSiteData(
  baseURL: string,
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), 'blocked-site-data-'))
  await mkdir(join(profile, 'Default'))
  await writeFile(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ profile: { default_content_setting_values: { cookies: 2 } } }),
  )
  // Full Chromium (new headless): the headless shell ignores the profile's
  // content settings.
  const context = await chromium.launchPersistentContext(profile, {
    baseURL,
    channel: 'chromium',
  })
  return {
    context,
    close: async () => {
      await context.close()
      await rm(profile, { recursive: true, force: true })
    },
  }
}
