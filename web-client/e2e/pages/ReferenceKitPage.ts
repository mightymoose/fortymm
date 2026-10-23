import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'

// The design system's shadcn/ui kit page, opened straight from references/.
// Its page chrome is what the app's design system page is built to match.
const kitUrl = new URL(
  '../../../references/fortymm-design-system/ui_kits/shadcn/index.html',
  import.meta.url,
).href

// The app's fonts, where its self-hosted Space Grotesk stylesheet lives.
const fontsDir = new URL('../../src/assets/fonts/', import.meta.url)

export class ReferenceKitPage {
  readonly page: Page
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator
  readonly intro: Locator
  readonly formsSection: Locator
  readonly formsSectionHeading: Locator
  readonly formsSectionLead: Locator
  readonly buttonCard: Locator
  readonly inputCard: Locator
  readonly textareaCard: Locator
  readonly textarea: Locator
  readonly otpCard: Locator
  readonly checkboxCard: Locator
  readonly radioCard: Locator
  readonly switchCard: Locator
  readonly sliderCard: Locator
  readonly selectCard: Locator
  readonly comboboxCard: Locator
  readonly datePickerCard: Locator
  readonly toggleCard: Locator
  readonly displaySectionHeading: Locator
  readonly displaySectionLead: Locator
  readonly cardCard: Locator
  readonly badgeCard: Locator
  readonly avatarCard: Locator
  readonly tableCard: Locator
  readonly progressCard: Locator
  readonly skeletonCard: Locator

  constructor(page: Page) {
    this.page = page
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
    // The paragraph right after the header.
    this.intro = page.getByRole('paragraph').first()
    // The kit's sections have ids but no accessible names, so they aren't
    // regions; find this one by its heading instead.
    this.formsSection = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Forms & Input' }),
    })
    this.formsSectionHeading = this.formsSection.getByRole('heading', {
      level: 2,
    })
    this.formsSectionLead = this.formsSection.getByRole('paragraph').first()
    // The kit's component cards are plain divs; find this one by its heading.
    this.buttonCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Button', exact: true }),
    })
    this.inputCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Input · Label · Form Field',
        exact: true,
      }),
    })
    this.textareaCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Textarea',
        exact: true,
      }),
    })
    // The kit's label isn't tied to its textarea, so take the card's only
    // textarea.
    this.textarea = this.textareaCard.locator('textarea')
    this.otpCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Input OTP',
        exact: true,
      }),
    })
    this.checkboxCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Checkbox',
        exact: true,
      }),
    })
    this.radioCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Radio Group',
        exact: true,
      }),
    })
    this.switchCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Switch', exact: true }),
    })
    this.sliderCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Slider', exact: true }),
    })
    this.selectCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Select', exact: true }),
    })
    this.comboboxCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Combobox',
        exact: true,
      }),
    })
    this.datePickerCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Date Picker',
        exact: true,
      }),
    })
    this.toggleCard = this.formsSection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Toggle · Toggle Group',
        exact: true,
      }),
    })
    const displaySection = page.locator('#display')
    this.displaySectionHeading = displaySection.getByRole('heading', {
      level: 2,
    })
    this.displaySectionLead = displaySection.getByRole('paragraph').first()
    this.cardCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Card', exact: true }),
    })
    this.badgeCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Badge', exact: true }),
    })
    this.avatarCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', { level: 3, name: 'Avatar', exact: true }),
    })
    this.tableCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Table · Data Table',
        exact: true,
      }),
    })
    this.progressCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Progress',
        exact: true,
      }),
    })
    this.skeletonCard = displaySection.locator('.comp', {
      has: page.getByRole('heading', {
        level: 3,
        name: 'Skeleton',
        exact: true,
      }),
    })
  }

  async goto(): Promise<void> {
    // The kit embeds its display and mono fonts but loads Space Grotesk from
    // Google Fonts. Serve it the app's own Space Grotesk stylesheet instead,
    // unchanged, so both pages load the same font files the same way, offline.
    // The stylesheet's relative URLs resolve to Google Fonts' host too, so
    // the font files come through this route as well.
    await this.page.route('https://fonts.googleapis.com/**', (route) => {
      const file = new URL(route.request().url()).pathname.slice(1)
      return route.fulfill({
        path: fileURLToPath(
          new URL(file.endsWith('.woff2') ? file : 'space-grotesk.css', fontsDir),
        ),
        // The kit is opened from disk, so its fonts are cross-origin.
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })
    await this.page.goto(kitUrl)
  }

  // The input card's input in the field labelled `name`. The kit's labels
  // aren't tied to their inputs, so find the field by its label's text.
  input(name: string): Locator {
    return this.inputCard
      .locator('.form-field')
      .filter({ has: this.page.locator('label', { hasText: name }) })
      .locator('input')
  }

  // Swaps in other header copy, so the header can be compared pixel for
  // pixel with a page that says something else.
  async setHeaderText(title: string, subtitle: string): Promise<void> {
    await this.title.evaluate((el, text) => (el.textContent = text), title)
    await this.subtitle.evaluate((el, text) => (el.textContent = text), subtitle)
  }
}
