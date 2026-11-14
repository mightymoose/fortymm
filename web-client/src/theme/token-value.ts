// The value a theme token has on this page, read from the stylesheet that
// defines it (tokens.css, theme.css) at the moment it is asked: '4px' for
// 's-1', '1.1' for 'lh-tight'. A token that refers to another
// (`--accent: var(--ball-500)`) gives the value it ends at.
//
// The design system page shows each token's value this way, never a copy of
// it, so what it shows is what the app paints with; the reference sheet's
// expected values are the check (its screenshots, compared by eye with the
// board). Empty where no stylesheet is loaded (in component tests).
export function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim()
}

// A colour token's value, written as the design system writes colours:
// '#FF7A1A', or 'rgba(255,122,26,0.14)' for one that is see-through. The
// build's minifier rewrites them ('#ff7a1a', '#ff7a1a24'); this writes the
// same colour back in the design system's notation (formatColour).
export function colourValue(name: string): string {
  return formatColour(tokenValue(name))
}

// '#ff7a1a' → '#FF7A1A'; '#ff7a1a24' → 'rgba(255,122,26,0.14)' (alpha to two
// places). Anything else is returned as it is.
export function formatColour(value: string): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value)
  if (hex === null) return value
  if (hex[2] === undefined) return `#${hex[1].toUpperCase()}`
  const [r, g, b] = [0, 2, 4].map((at) =>
    parseInt(hex[1].slice(at, at + 2), 16),
  )
  const alpha = (parseInt(hex[2], 16) / 255).toFixed(2)
  return `rgba(${r},${g},${b},${alpha})`
}
