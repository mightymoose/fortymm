import { expect, test } from 'vitest'
import { ColourTab } from './ColourTab.tsx'
import { ControlsTab } from './ControlsTab.tsx'
import { DesignSystemPage } from './DesignSystemLayout.page.tsx'
import { FeedbackTab } from './FeedbackTab.tsx'
import { FoundationsTab } from './FoundationsTab.tsx'
import { TypeTab } from './TypeTab.tsx'

// Each tab of the design system page, alone: a region named by its title,
// in the reference board's sections. How each looks is its screenshots
// (e2e/tests/design-system-*.spec.ts); what its components do is their own
// tests.
const tabs = [
  {
    title: 'Colour',
    tab: <ColourTab />,
    sections: [
      'Ink',
      'Chalk and ball',
      'Status hues and fixed values',
      'Action and selection',
      'Status',
      'Text, surfaces and borders',
      'Text on surfaces',
    ],
  },
  {
    title: 'Type',
    tab: <TypeTab />,
    sections: ['Families', 'Type styles', 'Size scale', 'Line heights'],
  },
  {
    title: 'Foundations',
    tab: <FoundationsTab />,
    sections: [
      'Spacing',
      'Radii',
      'Shadows and focus',
      'Status markers',
      'Icons',
    ],
  },
  {
    title: 'Controls',
    tab: <ControlsTab />,
    sections: [
      'Buttons',
      'Button sizes',
      'Fields',
      'Choices and selection',
      'Selection groups',
    ],
  },
  {
    title: 'Feedback',
    tab: <FeedbackTab />,
    sections: [
      'Card',
      'Warning and error',
      'Toast, tooltip, menu, dialog',
      'Tags, avatars, table, progress',
      'Navigation and empty state',
    ],
  },
]

for (const { title, tab, sections } of tabs) {
  test(`the ${title} tab shows the reference board’s sections`, async () => {
    const page = new DesignSystemPage()
    page.renderTab(tab)

    expect(await page.board(title)).toBeVisible()
    for (const section of sections) {
      expect(await page.boardSection(title, section)).toBeVisible()
    }
  })
}
