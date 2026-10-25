import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const reference = '../../references/design-system/'
const styles = '../src/styles/'
const tokensAndType = read(`${reference}colors_and_type.css`)

// The text from the line that matches `start` up to the line that matches
// `end`, inclusive, or to the end of `text` with no `end`.
function lines(text: string, start: RegExp, end?: RegExp): string {
  const all = text.split('\n')
  const from = all.findIndex((line) => start.test(line))
  expect(from).toBeGreaterThanOrEqual(0)
  const to = end
    ? all.findIndex((line, i) => i > from && end.test(line)) + 1
    : all.length
  return all.slice(from, to).join('\n')
}

// The app's styles are the design system reference's own, so the
// /design-system page renders like the reference's component gallery. No
// browser needed.
test.describe('the app styles', () => {
  test('use the reference kit.css unchanged', () => {
    expect(read(`${styles}kit.css`)).toBe(
      read(`${reference}ui_kits/components/kit.css`),
    )
  })

  test("use the reference's tokens unchanged", () => {
    expect(read(`${styles}tokens.css`)).toContain(
      lines(tokensAndType, /^:root\{/, /^\}/),
    )
  })

  test("use the reference's base, type roles, status markers and motion unchanged", () => {
    expect(read(`${styles}base.css`)).toContain(
      lines(tokensAndType, /^\/\* ---------- Base ---------- \*\/$/),
    )
  })

  test("use the gallery's page chrome, with .page for its .doc", () => {
    const gallery = read(`${reference}ui_kits/components/index.html`)
    const chrome = lines(gallery, /^<style>$/, /^<\/style>$/)
      .split('\n')
      .slice(1, -1)
      .join('\n')
      .replace('.doc{', '.page{')
      .replace('.doc h1{', '.page h1{')

    expect(read(`${styles}page.css`)).toContain(chrome)
  })
})

test("the favicon is the reference's logo mark, without its C2PA manifest", () => {
  const mark = read(`${reference}assets/logo-mark.svg`)
    .replace(/ xmlns:c2pa="[^"]*"/, '')
    .replace(/<metadata>.*<\/metadata>/s, '')

  expect(read('../public/favicon.svg')).toBe(mark)
})
