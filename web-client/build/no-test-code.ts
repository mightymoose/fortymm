import { join, sep } from 'node:path'
import type { Plugin } from 'vite'

// Fails the production build when it holds test code. The app imports none
// of it, so a build that holds some shipped it by mistake: an import from
// the app into a test's helper. Build only. Test code is:
// - src/test/: what only component tests use (the in-memory match source,
//   src/test/match-memory.ts, render helpers, the api's stand-ins);
// - a page object (*.page.tsx), a test's stand-in caller (*.match.tsx), and a
//   test file (*.test.*, *.test-d.*), wherever they sit beside a component;
// - the browser suite, e2e/ (its page objects and test-only harness pages);
// - the test-only packages: Testing Library, Playwright, Vitest and MSW.
// A module is matched by its path (`moduleIds`, absolute).

const root = join(import.meta.dirname, '..') + sep
const folders = [join(root, 'src', 'test') + sep, join(root, 'e2e') + sep]
const files = /\.(page|match)\.tsx?$|\.test(-d)?\.tsx?$/
const packages = /[\\/]node_modules[\\/](@testing-library|@playwright|playwright|playwright-core|vitest|@vitest|msw)[\\/]/

// Whether the module `id` is test code.
export function isTestCode(id: string): boolean {
  const path = id.split('?')[0]!
  return folders.some((folder) => path.startsWith(folder)) || files.test(path) || packages.test(path)
}

export function noTestCode(): Plugin {
  return {
    name: 'fortymm-no-test-code',
    apply: 'build',
    generateBundle(_options, bundle) {
      const shipped = Object.values(bundle)
        .flatMap((output) => (output.type === 'chunk' ? output.moduleIds : []))
        .filter(isTestCode)
      if (shipped.length > 0) {
        this.error(
          `The build holds test code, which the app must not import: ${[...new Set(shipped)].join(', ')}`,
        )
      }
    },
  }
}
