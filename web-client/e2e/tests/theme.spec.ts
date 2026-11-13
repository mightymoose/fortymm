import { expect, test } from '@playwright/test'
import {
  DesignSystemPage,
  HealthPage,
  SettingsPage,
  StartPage,
} from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'

// The FortyMM design system's theme (src/theme/), as the shipped build
// applies it. jsdom loads no CSS and no fonts, so these are the browser's.

test.beforeEach(async () => {
  await deploy('current')
})

// The design system's bg-app, ink-950 (#0B0D12).
const bgApp = 'rgb(11, 13, 18)'

test('every screen is on the theme’s bg-app, html and body both, and the page is a dark color scheme', async ({
  page,
}) => {
  const screens = [
    new StartPage(page),
    new DesignSystemPage(page),
    new HealthPage(page),
    new SettingsPage(page),
  ]
  for (const screen of screens) {
    await screen.goto()
    await expect(screen.heading).toBeVisible()

    const seen = await page.evaluate(() => {
      const html = getComputedStyle(document.documentElement)
      return {
        html: html.backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        colorScheme: html.colorScheme,
      }
    })
    expect(seen, page.url()).toEqual({
      html: bgApp,
      body: bgApp,
      colorScheme: 'dark',
    })
  }
})

// Every font face the app declares loads, and every font the page fetched is
// a file of the build, on the app's own origin: none from a font service.
test('Space Grotesk, Bebas Neue and JetBrains Mono load from the build, and nothing is fetched from another origin', async ({
  page,
  baseURL,
}) => {
  const fetched: { url: string; type: string }[] = []
  page.on('request', (request) =>
    fetched.push({ url: request.url(), type: request.resourceType() }),
  )
  const designSystem = new DesignSystemPage(page)
  await designSystem.goto()
  await expect(designSystem.heading).toBeVisible()

  const loaded = await page.evaluate(async () => {
    const families = ['Space Grotesk', 'Bebas Neue', 'JetBrains Mono']
    const faces = await Promise.all(
      families.map((family) => document.fonts.load(`16px "${family}"`)),
    )
    return Object.fromEntries(
      families.map((family, i) => [family, faces[i].map((f) => f.status)]),
    )
  })
  expect(loaded).toEqual({
    'Space Grotesk': ['loaded'],
    'Bebas Neue': ['loaded'],
    'JetBrains Mono': ['loaded'],
  })

  const origin = new URL(baseURL!).origin
  const fonts = fetched.filter((request) => request.type === 'font')
  expect(fonts.length).toBe(3)
  for (const font of fonts) {
    expect(font.url).toMatch(new RegExp(`^${origin}/assets/.+\\.woff2$`))
  }
  expect(fetched.filter((request) => !request.url.startsWith(origin))).toEqual(
    [],
  )
})

test('on /design-system, the title is set in Space Grotesk and the wordmark in Bebas Neue', async ({
  page,
}) => {
  const designSystem = new DesignSystemPage(page)
  await designSystem.goto()
  await expect(designSystem.heading).toBeVisible()

  const families = {
    heading: await designSystem.heading.evaluate(
      (element) => getComputedStyle(element).fontFamily,
    ),
    wordmark: await designSystem.wordmark.evaluate(
      (element) => getComputedStyle(element).fontFamily,
    ),
  }
  expect(families.heading).toMatch(/^"Space Grotesk",/)
  expect(families.wordmark).toMatch(/^"Bebas Neue",/)
  // The faces those families name are the ones rendered: loaded, not a
  // fallback.
  expect(
    await page.evaluate(() => [
      document.fonts.check('700 48px "Space Grotesk"'),
      document.fonts.check('400 48px "Bebas Neue"'),
    ]),
  ).toEqual([true, true])
})

// The browser's own colours around the app (its title bar, the splash screen
// of the installed app) are the page's background.
test('the theme-color and the manifest’s theme and background colours are the theme’s bg-app', async ({
  page,
}) => {
  await new StartPage(page).goto()
  const devtools = await page.context().newCDPSession(page)
  const { data } = await devtools.send('Page.getAppManifest')
  const manifest = JSON.parse(data ?? '{}')
  const themeColor = await page
    .locator('meta[name="theme-color"]')
    .getAttribute('content')

  expect({
    meta: rgbOf(themeColor ?? ''),
    manifestTheme: rgbOf(manifest.theme_color),
    manifestBackground: rgbOf(manifest.background_color),
  }).toEqual({
    meta: bgApp,
    manifestTheme: bgApp,
    manifestBackground: bgApp,
  })
})

function rgbOf(hex: string): string {
  const [r, g, b] = (hex.match(/^#(..)(..)(..)$/)?.slice(1) ?? []).map((pair) =>
    parseInt(pair, 16),
  )
  return `rgb(${r}, ${g}, ${b})`
}
