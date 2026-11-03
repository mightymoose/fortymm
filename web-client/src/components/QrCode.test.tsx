import { render, screen } from '@testing-library/react'
import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import vectors from '../../../api/signed-results/vectors.json'
import { QrCode } from './QrCode'
import { qrMatrix } from './qrMatrix'

const SCALE = 4

// Draws the matrix with its quiet zone into RGBA pixels and reads it back,
// as a camera would.
function decode(text: string): string | null {
  const matrix = qrMatrix(text)
  const width = (matrix.size + 8) * SCALE
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / SCALE) - 4
      const col = Math.floor(x / SCALE) - 4
      const inside = row >= 0 && col >= 0 && row < matrix.size && col < matrix.size
      if (inside && matrix.dark(row, col)) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)
    }
  }
  return jsQR(pixels, width, width)?.data ?? null
}

describe('QrCode', () => {
  it('encodes the text so a reader gets it back', () => {
    const longest = vectors.valid.find((vector) => vector.name === 'longest')!.qr
    expect(decode(longest)).toBe(longest)
  })

  it('fits the longest result in version 16', () => {
    const longest = vectors.valid.find((vector) => vector.name === 'longest')!.qr
    expect(qrMatrix(longest).size).toBeLessThanOrEqual(16 * 4 + 17)
  })

  it('is an image with its label', () => {
    render(<QrCode text="FMR1:ABC" label="Result QR code" />)
    expect(screen.getByRole('img', { name: 'Result QR code' })).toBeInTheDocument()
  })
})
