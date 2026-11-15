// What a type style is, in the reference sheet's words: size / line height /
// weight, then the letter spacing in em when it has one, a family before it
// when it isn't the UI family ("mono 96 / 1 / 700 / -0.03em"), and its
// colour token after it when it isn't fg-1 ("15 / 1.5 / 400 · fg-2").
//
// It is worked out from what the browser computed for a sample in that
// style (TypeTab), so the Type tab never repeats a style's values; the
// board's spec, beside the sample, is the check.

// What the browser computed for the sample (getComputedStyle).
export type ComputedType = {
  fontFamily: string
  fontSize: string
  lineHeight: string
  fontWeight: string
  letterSpacing: string
  color: string
}

// The theme's values to compare it with (tokenValue()).
export type TypeTokens = {
  // --font-num and --font-display.
  numFamily: string
  displayFamily: string
  // Text colours other than fg-1, by token: { 'fg-2': '#E4E7EF', ... }.
  colours: Record<string, string>
}

export function typeSpec(computed: ComputedType, tokens: TypeTokens): string {
  const size = parseFloat(computed.fontSize)
  const family = firstFamily(computed.fontFamily)
  const prefix =
    family === firstFamily(tokens.numFamily)
      ? 'mono '
      : family === firstFamily(tokens.displayFamily)
        ? 'Bebas '
        : ''
  const parts = [
    `${round(size)}`,
    lineHeight(computed.lineHeight, size),
    computed.fontWeight,
  ]
  const spacing = parseFloat(computed.letterSpacing)
  if (Number.isFinite(spacing) && spacing !== 0) {
    parts.push(`${round(spacing / size)}em`)
  }
  const colour = Object.entries(tokens.colours).find(
    ([, value]) => rgb(value) === rgb(computed.color),
  )
  return `${prefix}${parts.join(' / ')}${colour ? ` · ${colour[0]}` : ''}`
}

// A computed line height is in px; the sheet gives it as a ratio.
function lineHeight(value: string, size: number): string {
  if (value.endsWith('px')) return `${round(parseFloat(value) / size)}`
  return value
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function firstFamily(stack: string): string {
  return stack
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

// A colour as rgb(r, g, b), whether given as #RRGGBB or rgb(...).
function rgb(colour: string): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim())
  if (hex === null) return colour.replace(/\s+/g, '')
  return `rgb(${hex
    .slice(1)
    .map((pair) => parseInt(pair, 16))
    .join(',')})`
}
