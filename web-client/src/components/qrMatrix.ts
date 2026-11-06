import { create } from 'qrcode'

export type QrMatrix = { size: number; dark(row: number, col: number): boolean }

// The QR symbol of `text` at error correction level L. A code on a screen
// isn't torn or smudged as print is, and L's larger modules help a phone
// camera more than M's extra recovery would.
export function qrMatrix(text: string): QrMatrix {
  const { modules } = create(text, { errorCorrectionLevel: 'L' })
  return { size: modules.size, dark: (row, col) => modules.get(row, col) === 1 }
}
