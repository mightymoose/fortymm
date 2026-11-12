// Renders the app's install icons (PNG) from its icon, public/favicon.svg,
// with the Chromium of this suite's pinned Playwright image. Run it after
// changing the icon, look at the results, and commit them:
//
//   ./bin/mise run web-client:icons
//
// The task mounts web-client/public at /public. The icon is all shapes (its
// "40" is already outlines, from ../../scripts/icon-mark.ts), so no font is
// involved here.
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const publicDir = process.argv[2] ?? '/public'
const icon = await readFile(`${publicDir}/favicon.svg`)
const iconUrl = `data:image/svg+xml;base64,${icon.toString('base64')}`

// favicon.svg is an 80 by 80 box with a disc of radius 36 in it.
const discShareOfIcon = 72 / 80

// Opaque icons stand on the design system's bg-app (ink-950), the
// background the mark belongs on.
const bgApp = '#0B0D12'

type Icon = {
  file: string
  size: number
  // The disc's diameter, as a share of the icon's side.
  disc: number
  // null: transparent around the disc.
  background: string | null
}

const icons: Icon[] = [
  // "any": the mark as it is, transparent around the disc.
  { file: 'icon-192.png', size: 192, disc: 0.9, background: null },
  { file: 'icon-512.png', size: 512, disc: 0.9, background: null },
  // Maskable: full-bleed background, the disc inside the safe zone (the
  // central circle of 80% of the side), since launchers crop to their shape.
  { file: 'icon-maskable-512.png', size: 512, disc: 0.76, background: bgApp },
  // iPhone home screen: no transparency (iOS fills it with black); iOS
  // rounds the corners itself.
  { file: 'apple-touch-icon-180.png', size: 180, disc: 0.84, background: bgApp },
]

await mkdir(`${publicDir}/icons`, { recursive: true })
const browser = await chromium.launch()
try {
  for (const { file, size, disc, background } of icons) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    const imageSize = Math.round((size * disc) / discShareOfIcon)
    await page.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; width: ${size}px; height: ${size}px; }
        body {
          display: grid;
          place-items: center;
          background: ${background ?? 'transparent'};
        }
        img { width: ${imageSize}px; height: ${imageSize}px; }
      </style>
      <img src="${iconUrl}" alt="">`)
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode())
    await page.screenshot({
      path: `${publicDir}/icons/${file}`,
      omitBackground: background === null,
    })
    await page.close()
    console.log(`${publicDir}/icons/${file}: ${size}x${size}`)
  }
} finally {
  await browser.close()
}
