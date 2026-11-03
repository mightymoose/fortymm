import { qrMatrix } from './qrMatrix'

const QUIET_ZONE = 4

// A QR code as one SVG path. It stays dark on light, with its quiet zone,
// because cameras read that most reliably.
export function QrCode({ text, label }: { text: string; label: string }) {
  const matrix = qrMatrix(text)
  let path = ''
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.dark(row, col)) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`
    }
  }
  const extent = matrix.size + 2 * QUIET_ZONE
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="var(--chalk-50)" />
      <path d={path} fill="var(--ink-950)" />
    </svg>
  )
}
