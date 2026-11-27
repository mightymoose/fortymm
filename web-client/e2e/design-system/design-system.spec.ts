import { expect, test } from '@playwright/test'
import { targets } from './boards.ts'
import { type Margins } from './locators.ts'
import { type FoundationsExample, type SwatchGroup } from './main/main.board.ts'

// The colour swatches on the Foundations board, by group and name.
const swatches: Record<SwatchGroup, string[]> = {
  surfaces: [
    'ink-950 · bg-app',
    'ink-900 · bg-panel',
    'ink-800 · bg-group',
    'ink-700 · bg-hover',
    'ink-600 · border-subtle',
    'ink-500 · border-control',
    'ink-400 · fg-disabled',
  ],
  text: [
    'chalk-50 · fg-1',
    'chalk-100 · fg-2',
    'chalk-300 · fg-3',
    'chalk-500 · placeholder',
    'border-field',
  ],
  accent: [
    'ball-200 · accent-text',
    'ball-400 · hover, links',
    'ball-500 · accent',
    'ball-600 · pressed',
    'accent-soft',
  ],
  status: [
    'live',
    'serving, winner',
    'rating-up, success',
    'rating-down, loser',
    'conflict',
    'rest',
    'danger',
  ],
}

// The type rows on the Foundations board, by label.
const typeRows = [
  'h1 · 48 / 700',
  'h2 · 32 / 600',
  'h3 · 20 / 600',
  'text-md · 17 / 500',
  'body · 15 / 400',
  'label · 13 / 500',
  'meta · 13 / 400',
  'num · mono tabular',
  'score · 96 / 700 mono',
  'scoreboard-display · 48',
]

// The spacing scale on the Foundations board, by label.
const spacingRows = [
  's-1 · 4',
  's-2 · 8',
  's-3 · 12',
  's-4 · 16',
  's-5 · 20',
  's-6 · 24',
  's-8 · 32',
  's-12 · 48',
  's-16 · 64',
]

// The radius tiles on the Foundations board, by label.
const radiusTiles = ['r-sm · 6', 'r-md · 8', 'r-lg · 12', 'r-pill']

// The tiles on the Foundations board that paint outside their box, by label, with how far each
// paints past it: a shadow reaches its blur past the box, shifted by its offset; the focus ring is
// 4px all round. Each is captured with exactly that margin, so a tile's screenshot never takes in
// its neighbour's shadow.
const shadowTiles: Record<string, Margins> = {
  // --shadow-overlay: 0 8px 24px
  'shadow-overlay': { top: 16, right: 24, bottom: 32, left: 24 },
  // --shadow-tooltip: 0 4px 12px
  'shadow-tooltip': { top: 8, right: 12, bottom: 16, left: 12 },
  // --focus-ring: 0 0 0 2px ink-950, 0 0 0 4px ball-500
  'focus-ring': { top: 4, right: 4, bottom: 4, left: 4 },
}

// The status markers on the Foundations board: each one's text, and its screenshot's name.
const statusMarkers: Record<string, string> = {
  Live: 'live',
  'Patel, Meera': 'serving',
  '▲ +12': 'rating-up',
  '▼ −8': 'rating-down',
  'Rest until 19:35': 'rest',
  'Needs decision': 'conflict',
  'Scorer offline': 'offline',
}

// The icons on the Foundations board, by accessible name.
const icons = [
  'Info',
  'Clock',
  'Check',
  'Alert',
  'Error',
  'Offline',
  'Calendar',
  'Undo',
  'List',
  'Table',
  'Search',
  'More',
  'Close',
  'Chevron down',
  'Previous',
  'Next',
]

// Every example on the Foundations board, whole: what the item screenshots leave out (titles,
// descriptions, the space between items) and how the items sit together.
const foundationsExamples: FoundationsExample[] = [
  'found-colour-surfaces',
  'found-colour-text',
  'found-colour-accent',
  'found-colour-status',
  'found-type',
  'found-spacing',
  'found-radii-shadows',
  'found-status-markers',
  'found-icons',
]

// An item's screenshot is named after the first token of its label, under the given folders, e.g.
// foundations/ink-950.png for 'ink-950 · bg-app', foundations/serving.png for 'serving, winner'.
function screenshotName(folders: string[], label: string) {
  return [...folders, `${label.split(/ · |, /)[0]}.png`]
}

for (const target of targets) {
  test.describe(`design system (${target.name})`, () => {
    test.describe('main board', () => {
      test('shows the showcase title', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await expect(main.heading).toBeVisible()
      })

      test('shows the Foundations section', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await expect(main.foundationsHeading).toBeVisible()
      })

      test('links to Foundations', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await main.foundationsLink.click()
        await expect(main.foundationsHeading).toBeVisible()
      })

      test('links to Roles and buttons', async ({ page }) => {
        const { main, roles } = target.boards(page)
        await main.goto()
        await main.rolesLink.click()
        await expect(roles.rolesAtAGlanceHeading).toBeVisible()
      })

      test('links to Fields and selection', async ({ page }) => {
        const { main, forms } = target.boards(page)
        await main.goto()
        await main.formsLink.click()
        await expect(forms.fieldsAndChoicesHeading).toBeVisible()
      })

      test('links to Containers and feedback', async ({ page }) => {
        const { main, containers } = target.boards(page)
        await main.goto()
        await main.containersLink.click()
        await expect(containers.containersHeading).toBeVisible()
      })

      test('links to Overlays', async ({ page }) => {
        const { main, overlays } = target.boards(page)
        await main.goto()
        await main.overlaysLink.click()
        await expect(overlays.overlaysHeading).toBeVisible()
      })

      test('links to Match components', async ({ page }) => {
        const { main, match } = target.boards(page)
        await main.goto()
        await main.matchLink.click()
        await expect(match.matchComponentsHeading).toBeVisible()
      })

      test('links to More components', async ({ page }) => {
        const { main, more } = target.boards(page)
        await main.goto()
        await main.moreLink.click()
        await expect(more.moreComponentsHeading).toBeVisible()
      })

      test('links to State matrix', async ({ page }) => {
        const { main, states } = target.boards(page)
        await main.goto()
        await main.statesLink.click()
        await expect(states.stateMatrixHeading).toBeVisible()
      })

      // Screenshots are shared by both targets: the reference's are the baselines
      // (./bin/mise run web-client:screenshots), and the app must match them.
      for (const [group, names] of Object.entries(swatches) as [SwatchGroup, string[]][]) {
        for (const name of names) {
          test(`matches the ${name} swatch`, async ({ page }) => {
            const { main } = target.boards(page)
            await main.goto()
            await expect(main.swatch(group, name)).toHaveScreenshot(
              screenshotName(['foundations'], name),
            )
          })
        }
      }

      for (const name of typeRows) {
        test(`matches the ${name} type row`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.typeRow(name)).toHaveScreenshot(screenshotName(['foundations', 'type'], name))
        })
      }

      for (const name of spacingRows) {
        test(`matches the ${name} spacing row`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.spacingRow(name)).toHaveScreenshot(
            screenshotName(['foundations', 'spacing'], name),
          )
        })
      }

      for (const name of radiusTiles) {
        test(`matches the ${name} radius tile`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.radiiShadowsItem(name)).toHaveScreenshot(
            screenshotName(['foundations', 'radii'], name),
          )
        })
      }

      for (const [name, margins] of Object.entries(shadowTiles)) {
        test(`matches the ${name} tile`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          const clip = await main.findRadiiShadowsArea(name, margins)
          await expect(page).toHaveScreenshot(screenshotName(['foundations', 'shadows'], name), {
            clip,
            fullPage: true,
          })
        })
      }

      for (const [text, file] of Object.entries(statusMarkers)) {
        test(`matches the ${text} status marker`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.statusMarker(text)).toHaveScreenshot([
            'foundations',
            'status-markers',
            `${file}.png`,
          ])
        })
      }

      for (const name of icons) {
        test(`matches the ${name} icon`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.icon(name)).toHaveScreenshot([
            'foundations',
            'icons',
            `${name.toLowerCase().replaceAll(' ', '-')}.png`,
          ])
        })
      }

      for (const testId of foundationsExamples) {
        test(`matches the ${testId} example`, async ({ page }) => {
          const { main } = target.boards(page)
          await main.goto()
          await expect(main.example(testId)).toHaveScreenshot([
            'foundations',
            'examples',
            `${testId}.png`,
          ])
        })
      }

      test('matches the whole Foundations page', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await expect(main.foundationsPage).toHaveScreenshot(['foundations', 'page.png'])
      })
    })

    test('roles board shows Roles at a glance', async ({ page }) => {
      const { roles } = target.boards(page)
      await roles.goto()
      await expect(roles.rolesAtAGlanceHeading).toBeVisible()
    })

    test('roles board shows Buttons', async ({ page }) => {
      const { roles } = target.boards(page)
      await roles.goto()
      await expect(roles.buttonsHeading).toBeVisible()
    })

    test('forms board shows Fields and choices', async ({ page }) => {
      const { forms } = target.boards(page)
      await forms.goto()
      await expect(forms.fieldsAndChoicesHeading).toBeVisible()
    })

    test('forms board shows Selection', async ({ page }) => {
      const { forms } = target.boards(page)
      await forms.goto()
      await expect(forms.selectionHeading).toBeVisible()
    })

    test('containers board shows Containers', async ({ page }) => {
      const { containers } = target.boards(page)
      await containers.goto()
      await expect(containers.containersHeading).toBeVisible()
    })

    test('containers board shows Feedback', async ({ page }) => {
      const { containers } = target.boards(page)
      await containers.goto()
      await expect(containers.feedbackHeading).toBeVisible()
    })

    test('overlays board shows Overlays', async ({ page }) => {
      const { overlays } = target.boards(page)
      await overlays.goto()
      await expect(overlays.overlaysHeading).toBeVisible()
    })

    test('match board shows Match components', async ({ page }) => {
      const { match } = target.boards(page)
      await match.goto()
      await expect(match.matchComponentsHeading).toBeVisible()
    })

    test('more board shows More components', async ({ page }) => {
      const { more } = target.boards(page)
      await more.goto()
      await expect(more.moreComponentsHeading).toBeVisible()
    })

    test('states board shows State matrix', async ({ page }) => {
      const { states } = target.boards(page)
      await states.goto()
      await expect(states.stateMatrixHeading).toBeVisible()
    })
  })
}
