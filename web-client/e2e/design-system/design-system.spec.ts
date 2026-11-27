import { expect, test } from '@playwright/test'
import { targets } from './boards.ts'
import { type ControlRole, type Margins } from './locators.ts'
import { type ChoiceRole, type FormsExample } from './forms/forms.board.ts'
import { type FoundationsExample, type SwatchGroup } from './main/main.board.ts'
import { type RolesExample, type RolesRole } from './roles/roles.board.ts'

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

// The buttons in each example on the Roles board, by accessible name, and the links.
const rolesButtons: Record<RolesExample, string[]> = {
  'ex-variants': [
    'Call to table',
    'Reschedule',
    'Print score sheet',
    'Withdraw player…',
    'Withdraw',
    'Small',
    'Default',
    'Large',
    'Extra large',
    'More options',
    'Close',
    'Undo last point',
    'Search commands',
    '+1 Patel',
  ],
  'ex-loading-and-disabled': [
    'Saving…',
    'Exporting…',
    'Printing…',
    'Start match',
    'Call to table',
    'Reschedule',
    'Print sheet',
    'Withdraw…',
  ],
}
const rolesLinks: Record<RolesExample, string[]> = {
  'ex-variants': ['View draw'],
  'ex-loading-and-disabled': [],
}

// The roles at a glance on the Roles board that are screenshotted whole, by test id.
const rolesRoles: RolesRole[] = ['role-card', 'role-notice-examples', 'role-warning', 'role-error']

// How far the toast and the tooltip paint past their boxes: their shadows (see shadowTiles).
const toastMargins: Margins = { top: 16, right: 24, bottom: 32, left: 24 }
const tooltipMargins: Margins = { top: 8, right: 12, bottom: 16, left: 12 }

// The fields in each example on the Forms board, by their controls' accessible names.
const formsFields: Partial<Record<FormsExample, string[]>> = {
  'ex-text-field': [
    'Player name',
    'Club (optional)',
    'Table',
    'Entry fee',
    'Event',
    'Note for players',
  ],
}

// The code inputs in each example on the Forms board: their name, and the state each one is drawn
// in, in order (each screenshot is named after its state).
const formsCodeInputs: Partial<Record<FormsExample, { name: string; states: string[] }>> = {
  'ex-code-input': { name: 'Tournament code', states: ['found', 'error', 'disabled'] },
}

// The closed combobox fields in each example on the Forms board, by placeholder, and the examples
// with an open combobox.
const formsComboBoxFields: Partial<Record<FormsExample, string[]>> = {
  'ex-combobox': ['Search players or clubs'],
}
const formsOpenComboBoxes: FormsExample[] = ['ex-combobox']

// How far the open combobox and its list paint past their boxes: the focus ring is 4px all round;
// the list's shadow is --shadow-overlay (see shadowTiles).
const focusRingMargins: Margins = { top: 4, right: 4, bottom: 4, left: 4 }
const overlayMargins: Margins = { top: 16, right: 24, bottom: 32, left: 24 }

// The choices in each example on the Forms board, by their controls' roles and accessible names.
const formsChoices: Partial<Record<FormsExample, Partial<Record<ChoiceRole, string[]>>>> = {
  'ex-checkbox-radio-and-switch': {
    checkbox: ['Checked in', 'Needs an umpire', 'All players (12 of 16)', 'Paid online (not enabled)'],
    radio: ['Best of 3', 'Best of 5', 'Best of 7', 'Timed (not for this event)'],
    switch: [
      'Call players automatically',
      'Show ratings to spectators',
      'Text players (needs phone numbers)',
    ],
  },
}

// The examples on the Forms board that hold a range field.
const formsRangeFields: FormsExample[] = ['ex-checkbox-radio-and-switch']

// The date fields in each example on the Forms board, by name, and the examples with a calendar.
const formsDateFields: Partial<Record<FormsExample, string[]>> = {
  'ex-date-picker': ['Tournament date'],
}
const formsCalendars: FormsExample[] = ['ex-date-picker']

// Every example on the Forms board, whole. Rasterizing depends on where on the page a thing is
// drawn, so the app matches the board only when every example sits exactly where the board's does.
const formsExamples: FormsExample[] = [
  'ex-text-field',
  'ex-code-input',
  'ex-combobox',
  'ex-date-picker',
  'ex-checkbox-radio-and-switch',
  'ex-tabs',
  'ex-segmented',
  'ex-filter-chips',
  'ex-switch',
]

// The controls in each example on the Forms board that are their own whole, by role and name.
const formsControls: Partial<Record<FormsExample, [ControlRole, string][]>> = {
  'ex-tabs': [
    ['tab', 'Overview'],
    ['tab', 'Schedule'],
    ['tab', 'Standings'],
  ],
  'ex-segmented': [
    ['radio', 'Timeline'],
    ['radio', 'List'],
    ['radio', 'By player'],
  ],
  'ex-filter-chips': [
    ['button', 'All events'],
    ['button', 'Open singles'],
    ['button', 'Under 18'],
    ['button', 'Doubles'],
  ],
  'ex-switch': [['switch', 'Call players automatically']],
}

// A control's or field's screenshot is named after its accessible name, under its board's and
// example's folders, e.g. roles/variants/withdraw-player.png for 'Withdraw player…' in ex-variants.
function exampleScreenshotName(board: string, example: string, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return [board, example.replace(/^ex-/, ''), `${slug}.png`]
}

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

    test.describe('roles board', () => {
      test('shows Roles at a glance', async ({ page }) => {
        const { roles } = target.boards(page)
        await roles.goto()
        await expect(roles.rolesAtAGlanceHeading).toBeVisible()
      })

      test('shows Buttons', async ({ page }) => {
        const { roles } = target.boards(page)
        await roles.goto()
        await expect(roles.buttonsHeading).toBeVisible()
      })

      for (const [example, names] of Object.entries(rolesButtons) as [RolesExample, string[]][]) {
        for (const name of names) {
          test(`matches the ${name} button in ${example}`, async ({ page }) => {
            const { roles } = target.boards(page)
            await roles.goto()
            await expect(roles.button(example, name)).toHaveScreenshot(
              exampleScreenshotName('roles', example, name),
            )
          })
        }
      }

      for (const [example, names] of Object.entries(rolesLinks) as [RolesExample, string[]][]) {
        for (const name of names) {
          test(`matches the ${name} link in ${example}`, async ({ page }) => {
            const { roles } = target.boards(page)
            await roles.goto()
            await expect(roles.link(example, name)).toHaveScreenshot(
              exampleScreenshotName('roles', example, name),
            )
          })
        }
      }

      for (const example of Object.keys(rolesButtons) as RolesExample[]) {
        test(`matches the ${example} example`, async ({ page }) => {
          const { roles } = target.boards(page)
          await roles.goto()
          await expect(roles.example(example)).toHaveScreenshot(['roles', 'examples', `${example}.png`])
        })
      }

      for (const testId of rolesRoles) {
        test(`matches the ${testId} role`, async ({ page }) => {
          const { roles } = target.boards(page)
          await roles.goto()
          await expect(roles.role(testId)).toHaveScreenshot(['roles', 'roles', `${testId}.png`])
        })
      }

      test('matches the toast role', async ({ page }) => {
        const { roles } = target.boards(page)
        await roles.goto()
        const clip = await roles.findToastArea(toastMargins)
        await expect(page).toHaveScreenshot(['roles', 'roles', 'role-toast.png'], {
          clip,
          fullPage: true,
        })
      })

      test('matches the tooltip role', async ({ page }) => {
        const { roles } = target.boards(page)
        await roles.goto()
        const clip = await roles.findTooltipArea(tooltipMargins)
        await expect(page).toHaveScreenshot(['roles', 'roles', 'role-tooltip.png'], {
          clip,
          fullPage: true,
        })
      })

      test('matches the whole Roles page', async ({ page }) => {
        const { roles } = target.boards(page)
        await roles.goto()
        await expect(roles.rolesPage).toHaveScreenshot(['roles', 'page.png'])
      })
    })

    test.describe('forms board', () => {
      test('shows Fields and choices', async ({ page }) => {
        const { forms } = target.boards(page)
        await forms.goto()
        await expect(forms.fieldsAndChoicesHeading).toBeVisible()
      })

      test('shows Selection', async ({ page }) => {
        const { forms } = target.boards(page)
        await forms.goto()
        await expect(forms.selectionHeading).toBeVisible()
      })

      for (const [example, names] of Object.entries(formsFields) as [FormsExample, string[]][]) {
        for (const name of names) {
          test(`matches the ${name} field in ${example}`, async ({ page }) => {
            const { forms } = target.boards(page)
            await forms.goto()
            await expect(forms.field(example, name)).toHaveScreenshot(
              exampleScreenshotName('forms', example, name),
            )
          })
        }
      }

      for (const [example, { name, states }] of Object.entries(formsCodeInputs) as [
        FormsExample,
        { name: string; states: string[] },
      ][]) {
        states.forEach((state, index) => {
          test(`matches the ${state} ${name} code input in ${example}`, async ({ page }) => {
            const { forms } = target.boards(page)
            await forms.goto()
            await expect(forms.codeInput(example, name, index)).toHaveScreenshot(
              exampleScreenshotName('forms', example, `${name} ${state}`),
            )
          })
        })
      }

      for (const [example, placeholders] of Object.entries(formsComboBoxFields) as [
        FormsExample,
        string[],
      ][]) {
        for (const placeholder of placeholders) {
          test(`matches the ${placeholder} combobox in ${example}`, async ({ page }) => {
            const { forms } = target.boards(page)
            await forms.goto()
            await expect(forms.comboBoxField(example, placeholder)).toHaveScreenshot(
              exampleScreenshotName('forms', example, placeholder),
            )
          })
        }
      }

      for (const [example, names] of Object.entries(formsDateFields) as [FormsExample, string[]][]) {
        for (const name of names) {
          test(`matches the ${name} date field in ${example}`, async ({ page }) => {
            const { forms } = target.boards(page)
            await forms.goto()
            await expect(forms.dateField(example, name)).toHaveScreenshot(
              exampleScreenshotName('forms', example, name),
            )
          })
        }
      }

      for (const example of formsCalendars) {
        test(`matches the calendar in ${example}`, async ({ page }) => {
          const { forms } = target.boards(page)
          await forms.goto()
          await expect(forms.calendar(example)).toHaveScreenshot(
            exampleScreenshotName('forms', example, 'calendar'),
          )
        })
      }

      for (const example of formsOpenComboBoxes) {
        test(`matches the open combobox in ${example}`, async ({ page }) => {
          const { forms } = target.boards(page)
          await forms.goto()
          const clip = await forms.findOpenComboBoxArea(example, focusRingMargins)
          await expect(page).toHaveScreenshot(exampleScreenshotName('forms', example, 'open'), {
            clip,
            fullPage: true,
          })
        })

        test(`matches the open combobox's list in ${example}`, async ({ page }) => {
          const { forms } = target.boards(page)
          await forms.goto()
          const clip = await forms.findListBoxArea(example, overlayMargins)
          await expect(page).toHaveScreenshot(exampleScreenshotName('forms', example, 'list'), {
            clip,
            fullPage: true,
          })
        })
      }

      for (const [example, roles] of Object.entries(formsChoices) as [
        FormsExample,
        Partial<Record<ChoiceRole, string[]>>,
      ][]) {
        for (const [role, names] of Object.entries(roles) as [ChoiceRole, string[]][]) {
          for (const name of names) {
            test(`matches the ${name} ${role} in ${example}`, async ({ page }) => {
              const { forms } = target.boards(page)
              await forms.goto()
              await expect(forms.choice(example, role, name)).toHaveScreenshot(
                exampleScreenshotName('forms', example, name),
              )
            })
          }
        }
      }

      for (const example of formsRangeFields) {
        test(`matches the range field in ${example}`, async ({ page }) => {
          const { forms } = target.boards(page)
          await forms.goto()
          await expect(forms.rangeField(example)).toHaveScreenshot(
            exampleScreenshotName('forms', example, 'range field'),
          )
        })
      }

      for (const [example, controls] of Object.entries(formsControls) as [
        FormsExample,
        [ControlRole, string][],
      ][]) {
        for (const [role, name] of controls) {
          test(`matches the ${name} ${role} in ${example}`, async ({ page }) => {
            const { forms } = target.boards(page)
            await forms.goto()
            await expect(forms.control(example, role, name)).toHaveScreenshot(
              exampleScreenshotName('forms', example, name),
            )
          })
        }
      }

      test('matches the whole Forms page', async ({ page }) => {
        const { forms } = target.boards(page)
        await forms.goto()
        await expect(forms.formsPage).toHaveScreenshot(['forms', 'page.png'])
      })

      for (const example of formsExamples) {
        test(`matches the ${example} example`, async ({ page }) => {
          const { forms } = target.boards(page)
          await forms.goto()
          await expect(forms.example(example)).toHaveScreenshot(['forms', 'examples', `${example}.png`])
        })
      }
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
