import { expect, test } from 'vitest'
import { tokensShown } from './design-system-tokens.ts'

// A stylesheet's text, read from disk (component tests load no CSS), from
// web-client/, where the tests run. (Typed here: the app's tsconfig has no
// Node types.)
async function stylesheet(name: string): Promise<string> {
  const { readFile } = (await import('node:fs/promises' as string)) as {
    readFile: (path: string, encoding: 'utf8') => Promise<string>
  }
  return readFile(`src/theme/${name}`, 'utf8')
}

// The design system page paints and labels each token by its name; a name
// the theme doesn't define would show an empty swatch with no value.
test('every token the design system page shows is defined by the theme', async () => {
  const css = (await stylesheet('tokens.css')) + (await stylesheet('theme.css'))
  const defined = new Set(
    [...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map(([, name]) => name),
  )

  expect(tokensShown.filter((name) => !defined.has(name))).toEqual([])
})
