// Renders the app's install icons (PNG) from its icon, public/favicon.svg,
// with the Chromium of this suite's pinned Playwright image. Run it after
// changing the icon, look at the results, and commit them:
//
//   ./bin/mise run web-client:icons
//
// The task mounts web-client/public at /public. The "40" in the icon is text
// in Arial; the image has no Arial, and its font configuration draws Arial
// with Liberation Sans, which has the same letter widths. The font it used is
// printed at the end.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const publicDir = process.argv[2] ?? '/public'
const icon = await readFile(`${publicDir}/favicon.svg`)
const iconUrl = `data:image/svg+xml;base64,${icon.toString('base64')}`

// Opaque icons stand on the app's page background.
const background = '#ffffff'

type Icon = {
  file: string
  size: number
  // The ball's diameter, as a share of the icon's side.
  ball: number
  // null: transparent around the ball.
  background: string | null
}

const icons: Icon[] = [
  // "any": the ball edge to edge, transparent around it.
  { file: 'icon-192.png', size: 192, ball: 1, background: null },
  { file: 'icon-512.png', size: 512, ball: 1, background: null },
  // Maskable: full-bleed background, the ball inside the safe zone (the
  // central circle of 80% of the side), since launchers crop to their shape.
  { file: 'icon-maskable-512.png', size: 512, ball: 0.72, background },
  // iPhone home screen: no transparency (iOS fills it with black); iOS
  // rounds the corners itself.
  { file: 'apple-touch-icon-180.png', size: 180, ball: 0.84, background },
]

await mkdir(`${publicDir}/icons`, { recursive: true })
const browser = await chromium.launch()
try {
  for (const { file, size, ball, background } of icons) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    const ballSize = Math.round(size * ball)
    await page.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; width: ${size}px; height: ${size}px; }
        body {
          display: grid;
          place-items: center;
          background: ${background ?? 'transparent'};
        }
        img { width: ${ballSize}px; height: ${ballSize}px; }
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

const font = execFileSync('fc-match', ['Arial:bold'], { encoding: 'utf8' })
console.log(`"40" was drawn in: ${font.trim()}`)
