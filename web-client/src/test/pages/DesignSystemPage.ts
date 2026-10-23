import { screen, within } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the design system page in unit tests. Elements are looked
// up through `screen` on every access, so they always reflect the current
// render.
export class DesignSystemPage {
  // The page doesn't check the API's health, so this doesn't wait for it.
  static async render(): Promise<DesignSystemPage> {
    await renderRoute('/design-system', { waitForHealth: false })
    return new DesignSystemPage()
  }

  // The loading screen, or null while it isn't shown.
  get loadingScreen(): HTMLElement | null {
    return screen.queryByRole('status', { name: 'Loading FortyMM' })
  }

  get homeLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Home' })
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The paragraph right after the page's header.
  get intro(): HTMLElement {
    return screen.getAllByRole('paragraph')[0]
  }

  get formsSection(): HTMLElement {
    return screen.getByRole('region', { name: 'Forms & Input' })
  }

  get formsSectionHeading(): HTMLElement {
    return within(this.formsSection).getByRole('heading', { level: 2 })
  }

  get formsSectionLead(): HTMLElement {
    return within(this.formsSection).getByRole('paragraph')
  }

  get buttonCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Button' })
  }

  get buttonCardHeading(): HTMLElement {
    return within(this.buttonCard).getByRole('heading', { level: 3 })
  }

  button(name: string): HTMLElement {
    return within(this.buttonCard).getByRole('button', { name })
  }

  get inputCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', {
      name: 'Input · Label · Form Field',
    })
  }

  get inputCardHeading(): HTMLElement {
    return within(this.inputCard).getByRole('heading', { level: 3 })
  }

  // The text input labelled `name`, so finding it proves the label is
  // associated with it.
  input(name: string): HTMLElement {
    return within(this.inputCard).getByRole('textbox', { name })
  }

  get textareaCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Textarea' })
  }

  get textareaCardHeading(): HTMLElement {
    return within(this.textareaCard).getByRole('heading', { level: 3 })
  }

  // The Match notes textarea, found by its label, so finding it proves the
  // label is associated with it.
  get textarea(): HTMLElement {
    return within(this.textareaCard).getByRole('textbox', {
      name: 'Match notes',
    })
  }

  get otpCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Input OTP' })
  }

  get otpCardHeading(): HTMLElement {
    return within(this.otpCard).getByRole('heading', { level: 3 })
  }

  // The one-time code input, found by its hidden label, so finding it proves
  // the label is associated with it.
  get otpInput(): HTMLElement {
    return within(this.otpCard).getByRole('textbox', {
      name: 'Verification code',
    })
  }

  get otpLabel(): HTMLElement {
    return within(this.otpCard).getByText('Verification code')
  }

  get checkboxCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Checkbox' })
  }

  get checkboxCardHeading(): HTMLElement {
    return within(this.checkboxCard).getByRole('heading', { level: 3 })
  }

  // The checkbox labelled `name`, so finding it proves the label is
  // associated with it.
  checkbox(name: string): HTMLElement {
    return within(this.checkboxCard).getByRole('checkbox', { name })
  }

  get radioCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', {
      name: 'Radio Group',
    })
  }

  get radioCardHeading(): HTMLElement {
    return within(this.radioCard).getByRole('heading', { level: 3 })
  }

  // The Match format group, found by its hidden label, so finding it proves
  // the label names it.
  get radioGroup(): HTMLElement {
    return within(this.radioCard).getByRole('radiogroup', {
      name: 'Match format',
    })
  }

  get radioGroupLabel(): HTMLElement {
    return within(this.radioCard).getByText('Match format')
  }

  // The group's radio labelled `name`, so finding it proves the label is
  // associated with it.
  radio(name: string): HTMLElement {
    return within(this.radioGroup).getByRole('radio', { name })
  }

  get switchCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Switch' })
  }

  get switchCardHeading(): HTMLElement {
    return within(this.switchCard).getByRole('heading', { level: 3 })
  }

  // The switch labelled `name`, so finding it proves the label is associated
  // with it.
  switch(name: string): HTMLElement {
    return within(this.switchCard).getByRole('switch', { name })
  }

  get sliderCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Slider' })
  }

  get sliderCardHeading(): HTMLElement {
    return within(this.sliderCard).getByRole('heading', { level: 3 })
  }

  // The slider (one input) named `name`, so finding it proves its label
  // names it.
  slider(name: string): HTMLElement {
    return within(this.sliderCard).getByRole('slider', { name })
  }

  // The value readouts, in order.
  get sliderValues(): HTMLElement[] {
    return within(this.sliderCard).getAllByRole('status')
  }

  get selectCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Select' })
  }

  get selectCardHeading(): HTMLElement {
    return within(this.selectCard).getByRole('heading', { level: 3 })
  }

  // The select named `name`.
  select(name: string): HTMLElement {
    return within(this.selectCard).getByRole('combobox', { name })
  }

  get comboboxCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', { name: 'Combobox' })
  }

  get comboboxCardHeading(): HTMLElement {
    return within(this.comboboxCard).getByRole('heading', { level: 3 })
  }

  get combobox(): HTMLElement {
    return within(this.comboboxCard).getByRole('combobox', {
      name: 'Find a player',
    })
  }

  // The combobox's shown options, in order.
  get comboboxOptions(): HTMLElement[] {
    return within(this.comboboxCard).getAllByRole('option')
  }

  get datePickerCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', {
      name: 'Date Picker',
    })
  }

  get datePickerCardHeading(): HTMLElement {
    return within(this.datePickerCard).getByRole('heading', { level: 3 })
  }

  // The button that opens the calendar. Its name starts with its label, so
  // finding it proves the label names it.
  get datePickerTrigger(): HTMLElement {
    return within(this.datePickerCard).getByRole('button', {
      name: /^Match date/,
    })
  }

  get datePickerDialog(): HTMLElement {
    return within(this.datePickerCard).getByRole('dialog')
  }

  get datePickerGrid(): HTMLElement {
    return within(this.datePickerDialog).getByRole('grid')
  }

  // The calendar's day named `name`, e.g. "April 12, 2026".
  datePickerDay(name: string): HTMLElement {
    return within(this.datePickerGrid).getByRole('gridcell', { name })
  }

  get toggleCard(): HTMLElement {
    return within(this.formsSection).getByRole('article', {
      name: 'Toggle · Toggle Group',
    })
  }

  get toggleCardHeading(): HTMLElement {
    return within(this.toggleCard).getByRole('heading', { level: 3 })
  }

  // The standalone toggle named `name`, e.g. "Bold".
  toggle(name: string): HTMLElement {
    return within(this.toggleCard).getByRole('button', { name })
  }

  get toggleSeparator(): HTMLElement {
    return within(this.toggleCard).getByRole('separator')
  }

  get toggleGroup(): HTMLElement {
    return within(this.toggleCard).getByRole('radiogroup', {
      name: 'Match type',
    })
  }

  // The group's items, in order.
  get toggleGroupItems(): HTMLElement[] {
    return within(this.toggleGroup).getAllByRole('radio')
  }

  get displaySection(): HTMLElement {
    return screen.getByRole('region', { name: 'Data Display' })
  }

  get displaySectionHeading(): HTMLElement {
    return within(this.displaySection).getByRole('heading', { level: 2 })
  }

  // The first paragraph: the cards in the section have paragraphs too.
  get displaySectionLead(): HTMLElement {
    return within(this.displaySection).getAllByRole('paragraph')[0]
  }

  get cardCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', { name: 'Card' })
  }

  get cardCardHeading(): HTMLElement {
    return within(this.cardCard).getByRole('heading', { level: 3 })
  }

  // The demo card titled `name`, e.g. "April Spring Open".
  demoCard(name: string): HTMLElement {
    return within(this.cardCard).getByRole('article', { name })
  }

  get badgeCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', { name: 'Badge' })
  }

  get badgeCardHeading(): HTMLElement {
    return within(this.badgeCard).getByRole('heading', { level: 3 })
  }

  // A badge is a styled span with no role of its own, so the badges are
  // found by their class.
  get badges(): HTMLElement[] {
    return Array.from(this.badgeCard.querySelectorAll<HTMLElement>('.badge'))
  }

  get avatarCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', { name: 'Avatar' })
  }

  get avatarCardHeading(): HTMLElement {
    return within(this.avatarCard).getByRole('heading', { level: 3 })
  }

  // Every avatar in the Avatar card, the group's overflow circle included,
  // in order.
  get avatars(): HTMLElement[] {
    return within(this.avatarCard).getAllByRole('img')
  }

  get avatarGroup(): HTMLElement {
    return within(this.avatarCard).getByRole('group', { name: 'Players' })
  }

  get tableCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', {
      name: 'Table · Data Table',
    })
  }

  get tableCardHeading(): HTMLElement {
    return within(this.tableCard).getByRole('heading', { level: 3 })
  }

  get standingsTable(): HTMLElement {
    return within(this.tableCard).getByRole('table', { name: 'Standings' })
  }

  get progressCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', {
      name: 'Progress',
    })
  }

  get progressCardHeading(): HTMLElement {
    return within(this.progressCard).getByRole('heading', { level: 3 })
  }

  // The Progress card's bars, in order.
  get progressBars(): HTMLElement[] {
    return within(this.progressCard).getAllByRole('progressbar')
  }

  get skeletonCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', {
      name: 'Skeleton',
    })
  }

  get skeletonCardHeading(): HTMLElement {
    return within(this.skeletonCard).getByRole('heading', { level: 3 })
  }

  // The placeholders are hidden from assistive tech, so they have no role to
  // find them by.
  get skeletons(): HTMLElement[] {
    return Array.from(
      this.skeletonCard.querySelectorAll<HTMLElement>('.skeleton'),
    )
  }

  get aspectRatioCard(): HTMLElement {
    return within(this.displaySection).getByRole('article', {
      name: 'Aspect Ratio',
    })
  }

  get aspectRatioCardHeading(): HTMLElement {
    return within(this.aspectRatioCard).getByRole('heading', { level: 3 })
  }

  // The Aspect Ratio card's boxes, in order.
  get aspectRatioBoxes(): HTMLElement[] {
    return Array.from(
      this.aspectRatioCard.querySelectorAll<HTMLElement>('.aspect-ratio'),
    )
  }
}
