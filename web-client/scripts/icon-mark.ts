// Writes public/favicon.svg, the app's icon: the design system's logo mark (a
// flat ball-500 disc) with "40" on it in Space Grotesk Bold, filled
// on-accent. The "40" is drawn as outlines, not text, since an SVG favicon
// can't load a web font and no render image has Space Grotesk. Run it in a
// web-client container, then render the install icons from the result:
//
//   ./bin/mise run web-client:exec -- node scripts/icon-mark.ts
//   ./bin/mise run web-client:icons
//
// It fetches Space Grotesk Bold (static weight 700, TrueType) from Google
// Fonts, the hosted font the design system uses (SIL Open Font License), and
// reads the two glyphs' outlines itself: a TrueType file needs only a few
// tables for that. The font file is not kept.
import { writeFile } from 'node:fs/promises'

// Design system tokens.
const ball500 = '#FF7A1A'
const onAccent = '#0B0D12'
// The mark: an 80 by 80 box with a disc of radius 36.
const box = 80
const disc = 36
// The "40" as it sat in the earlier icon: its em is 0.47 of the disc's
// diameter. Headings' letter spacing: -0.02em.
const fontSize = 0.47 * 2 * disc
const letterSpacing = -0.02
const text = '40'

async function fetchFont(): Promise<DataView> {
  // Without a browser's user agent, Google Fonts answers with TrueType.
  const css = await (
    await fetch('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700')
  ).text()
  const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1]
  if (!url) throw new Error(`No TrueType font in Google Fonts' answer:\n${css}`)
  console.log(`Font: ${url}`)
  return new DataView(await (await fetch(url)).arrayBuffer())
}

type Point = { x: number; y: number; onCurve: boolean }
type Glyph = {
  contours: Point[][]
  advance: number
  xMin: number
  yMin: number
  xMax: number
  yMax: number
}

function readFont(font: DataView) {
  const tables = new Map<string, number>()
  const numTables = font.getUint16(4)
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16
    const tag = String.fromCharCode(
      ...[0, 1, 2, 3].map((k) => font.getUint8(record + k)),
    )
    tables.set(tag, font.getUint32(record + 8))
  }
  const table = (tag: string) => {
    const offset = tables.get(tag)
    if (offset === undefined) throw new Error(`The font has no ${tag} table`)
    return offset
  }

  const head = table('head')
  const unitsPerEm = font.getUint16(head + 18)
  const longLoca = font.getInt16(head + 50) === 1
  const numberOfHMetrics = font.getUint16(table('hhea') + 34)
  const hmtx = table('hmtx')
  const loca = table('loca')
  const glyf = table('glyf')

  function glyphIndex(char: number): number {
    const cmap = table('cmap')
    const count = font.getUint16(cmap + 2)
    for (let i = 0; i < count; i++) {
      const platform = font.getUint16(cmap + 4 + i * 8)
      const encoding = font.getUint16(cmap + 6 + i * 8)
      const sub = cmap + font.getUint32(cmap + 8 + i * 8)
      const unicode = platform === 0 || (platform === 3 && encoding === 1)
      if (!unicode || font.getUint16(sub) !== 4) continue
      const segments = font.getUint16(sub + 6) / 2
      const ends = sub + 14
      const starts = ends + segments * 2 + 2
      const deltas = starts + segments * 2
      const rangeOffsets = deltas + segments * 2
      for (let s = 0; s < segments; s++) {
        if (font.getUint16(ends + s * 2) < char) continue
        const start = font.getUint16(starts + s * 2)
        if (start > char) break
        const delta = font.getInt16(deltas + s * 2)
        const rangeOffset = font.getUint16(rangeOffsets + s * 2)
        if (rangeOffset === 0) return (char + delta) & 0xffff
        const id = font.getUint16(
          rangeOffsets + s * 2 + rangeOffset + (char - start) * 2,
        )
        return id === 0 ? 0 : (id + delta) & 0xffff
      }
    }
    throw new Error(`No glyph for U+${char.toString(16)}`)
  }

  function glyph(char: string): Glyph {
    const id = glyphIndex(char.codePointAt(0)!)
    const advance = font.getUint16(hmtx + Math.min(id, numberOfHMetrics - 1) * 4)
    const at = longLoca
      ? font.getUint32(loca + id * 4)
      : font.getUint16(loca + id * 2) * 2
    const g = glyf + at
    const numberOfContours = font.getInt16(g)
    if (numberOfContours < 0) throw new Error(`"${char}" is a composite glyph`)
    const bounds = {
      xMin: font.getInt16(g + 2),
      yMin: font.getInt16(g + 4),
      xMax: font.getInt16(g + 6),
      yMax: font.getInt16(g + 8),
    }
    const endPoints: number[] = []
    for (let c = 0; c < numberOfContours; c++) {
      endPoints.push(font.getUint16(g + 10 + c * 2))
    }
    const numPoints = endPoints[endPoints.length - 1] + 1
    let p = g + 10 + numberOfContours * 2
    p += 2 + font.getUint16(p) // instructions
    const flags: number[] = []
    while (flags.length < numPoints) {
      const flag = font.getUint8(p++)
      flags.push(flag)
      if (flag & 8) {
        for (let r = font.getUint8(p++); r > 0; r--) flags.push(flag)
      }
    }
    const coordinates = (short: number, same: number) => {
      const values: number[] = []
      let value = 0
      for (const flag of flags) {
        if (flag & short) {
          const d = font.getUint8(p++)
          value += flag & same ? d : -d
        } else if (!(flag & same)) {
          value += font.getInt16(p)
          p += 2
        }
        values.push(value)
      }
      return values
    }
    const xs = coordinates(2, 16)
    const ys = coordinates(4, 32)
    const contours: Point[][] = []
    let first = 0
    for (const last of endPoints) {
      const contour: Point[] = []
      for (let i = first; i <= last; i++) {
        contour.push({ x: xs[i], y: ys[i], onCurve: (flags[i] & 1) === 1 })
      }
      contours.push(contour)
      first = last + 1
    }
    return { contours, advance, ...bounds }
  }

  return { unitsPerEm, glyph }
}

// A TrueType contour (quadratic, with implied on-curve midpoints between two
// off-curve points) as SVG path commands, through `at` to the mark's box.
function contourPath(contour: Point[], at: (p: Point) => string): string {
  const mid = (a: Point, b: Point): Point => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    onCurve: true,
  })
  const n = contour.length
  const startIndex = contour.findIndex((p) => p.onCurve)
  const start =
    startIndex >= 0 ? contour[startIndex] : mid(contour[n - 1], contour[0])
  const from = startIndex >= 0 ? startIndex : n - 1
  const commands = [`M${at(start)}`]
  for (let k = 1; k <= n; k++) {
    const point = contour[(from + k) % n]
    if (point.onCurve) {
      commands.push(`L${at(point)}`)
      continue
    }
    const next = contour[(from + k + 1) % n]
    const end = next.onCurve ? next : mid(point, next)
    commands.push(`Q${at(point)} ${at(end)}`)
    if (next.onCurve) k++
  }
  return `${commands.join('')}Z`
}

const { unitsPerEm, glyph } = readFont(await fetchFont())

// Lay the glyphs out on one line, in font units, then centre their ink on
// the disc.
const placed: { glyph: Glyph; x: number }[] = []
let pen = 0
for (const char of text) {
  const g = glyph(char)
  placed.push({ glyph: g, x: pen })
  pen += g.advance + letterSpacing * unitsPerEm
}
const xMin = Math.min(...placed.map(({ glyph, x }) => x + glyph.xMin))
const xMax = Math.max(...placed.map(({ glyph, x }) => x + glyph.xMax))
const yMin = Math.min(...placed.map(({ glyph }) => glyph.yMin))
const yMax = Math.max(...placed.map(({ glyph }) => glyph.yMax))
const scale = fontSize / unitsPerEm
const round = (v: number) => Number(v.toFixed(2))

const d = placed
  .flatMap(({ glyph, x }) =>
    glyph.contours.map((contour) =>
      contourPath(contour, (p) => {
        const sx = box / 2 + (x + p.x - (xMin + xMax) / 2) * scale
        const sy = box / 2 - (p.y - (yMin + yMax) / 2) * scale
        return `${round(sx)} ${round(sy)}`
      }),
    ),
  )
  .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${box}" height="${box}">
  <!-- The app's icon: the design system's logo mark, a flat ball-500 disc
       (${ball500}), with "40" in on-accent (${onAccent}). The "40" is
       Space Grotesk Bold (weight 700, letter-spacing -0.02em) as outlines,
       made by scripts/icon-mark.ts. The install icons in icons/ are rendered
       from this file by web-client:icons. -->
  <circle cx="${box / 2}" cy="${box / 2}" r="${disc}" fill="${ball500}"/>
  <path fill="${onAccent}" d="${d}"/>
</svg>
`
await writeFile('public/favicon.svg', svg)
console.log(`Wrote public/favicon.svg ("${text}": ${round((xMax - xMin) * scale)} by ${round((yMax - yMin) * scale)})`)
