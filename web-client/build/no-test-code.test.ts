import { join } from 'node:path'
import { expect, test } from 'vitest'
import { noTestCode } from './no-test-code.ts'

// The production build's check that it ships no test code (no-test-code.ts),
// given a fake bundle: one chunk holding the module ids it names.

const root = join(import.meta.dirname, '..')
const at = (...path: string[]) => join(root, ...path)

// What the plugin does with a bundle of one chunk of these modules: the
// error it raises, or null.
function check(moduleIds: string[]): string | null {
  const plugin = noTestCode()
  const hook = plugin.generateBundle as (
    this: { error(message: string): never },
    options: unknown,
    bundle: Record<string, unknown>,
  ) => void
  try {
    hook.call(
      {
        error(message: string): never {
          throw new Error(message)
        },
      },
      {},
      {
        'assets/index.js': { type: 'chunk', moduleIds },
        'assets/style.css': { type: 'asset' },
      },
    )
    return null
  } catch (error) {
    return (error as Error).message
  }
}

const app = [
  at('src', 'main.tsx'),
  at('src', 'components', 'scoring', 'ScoringScreen.tsx'),
  at('node_modules', 'react', 'index.js'),
  at('node_modules', '@tanstack', 'react-router', 'dist', 'esm', 'index.js'),
  '\0vite/modulepreload-polyfill.js',
]

test('the app’s own modules and its packages are allowed', () => {
  expect(check(app)).toBeNull()
})

test.each([
  { name: 'a component test helper (src/test/)', id: at('src', 'test', 'match-memory.ts') },
  { name: 'a page object', id: at('src', 'components', 'scoring', 'ScoringScreen.page.tsx') },
  { name: 'a test’s stand-in caller (.match.tsx)', id: at('src', 'components', 'scoring', 'ScoringScreen.match.tsx') },
  { name: 'a test file', id: at('src', 'components', 'Scoring.test.tsx') },
  { name: 'the browser suite (e2e/)', id: at('e2e', 'pages', 'app.ts') },
  { name: 'Testing Library', id: at('node_modules', '@testing-library', 'dom', 'dist', 'index.js') },
  { name: 'user-event', id: at('node_modules', '@testing-library', 'user-event', 'dist', 'index.js') },
  { name: 'Playwright', id: at('node_modules', '@playwright', 'test', 'index.js') },
  { name: 'Playwright’s core', id: at('node_modules', 'playwright-core', 'index.js') },
  { name: 'Vitest', id: at('node_modules', 'vitest', 'dist', 'index.js') },
  { name: 'MSW', id: at('node_modules', 'msw', 'lib', 'core', 'index.mjs') },
])('$name in the build fails it, naming the module', ({ id }) => {
  const error = check([...app, id])

  expect(error).not.toBeNull()
  expect(error).toContain(id)
})
