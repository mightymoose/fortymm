import { create } from 'qrcode'

export type QrMatrix = { size: number; dark(row: number, col: number): boolean }

// The QR symbol of `text` at error correction level M, which the signed
// result format budgets for.
export function qrMatrix(text: string): QrMatrix {
  const { modules } = create(text, { errorCorrectionLevel: 'M' })
  return { size: modules.size, dark: (row, col) => modules.get(row, col) === 1 }
}
