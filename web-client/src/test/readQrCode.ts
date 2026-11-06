import jsQR from 'jsqr'

const SCALE = 4

// Reads a rendered QrCode as a camera would: draws each dark module of its
// SVG path into RGBA pixels, quiet zone included, and decodes them. It reads
// the one-module squares `QrCode` writes, so a change to that path changes it.
export function readQrCode(svg: Element): string | null {
  const extent = Number(svg.getAttribute('viewBox')!.split(' ')[2])
  const width = extent * SCALE
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  const path = svg.querySelector('path')!.getAttribute('d')!
  for (const [, col, row] of path.matchAll(/M(\d+) (\d+)/g)) {
    for (let y = Number(row) * SCALE; y < (Number(row) + 1) * SCALE; y++) {
      const start = (y * width + Number(col) * SCALE) * 4
      for (let x = 0; x < SCALE; x++) pixels.fill(0, start + x * 4, start + x * 4 + 3)
    }
  }
  return jsQR(pixels, width, width)?.data ?? null
}
