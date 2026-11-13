import { expect, test } from '@playwright/test'
import { App, StartPage } from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'

test.beforeEach(async () => {
  await deploy('current')
})

type InstallabilityError = { errorId: string }

// What a browser needs before it offers to install the app, asked of
// Chromium itself (its installability check, through the DevTools protocol),
// plus what the brief asks of the manifest and the icon iPhones use, which no
// browser here can check. Chromium also reports "in-incognito", because a
// test browser's profile is a throwaway one; a person's never is.
test('the app meets what a browser needs to offer installing it, and carries the iPhone home-screen icon', async ({
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  const devtools = await page.context().newCDPSession(page)

  const { installabilityErrors } = (await devtools.send(
    'Page.getInstallabilityErrors',
  )) as { installabilityErrors: InstallabilityError[] }
  expect(
    installabilityErrors
      .map((error) => error.errorId)
      .filter((id) => id !== 'in-incognito'),
  ).toEqual([])

  const { data } = await devtools.send('Page.getAppManifest')
  const manifest = JSON.parse(data ?? '{}')
  expect(manifest).toMatchObject({
    name: 'fortymm',
    short_name: 'fortymm',
    start_url: '/',
    display: 'standalone',
  })
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))

  const appleIcon = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-icon"]',
    )
    if (!link) return null
    const image = new Image()
    image.src = link.href
    await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  })
  expect(appleIcon).toEqual({ width: 180, height: 180 })
})
