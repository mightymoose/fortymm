import type { Locator, Page } from '@playwright/test'

// Page object for the design system page in the Playwright suite.
export class DesignSystemPage {
  readonly page: Page
  readonly loadingScreen: Locator
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator
  readonly intro: Locator
  readonly formsSection: Locator
  readonly formsSectionHeading: Locator
  readonly formsSectionLead: Locator
  readonly cards: Locator
  readonly buttonCard: Locator
  readonly inputCard: Locator
  readonly inputCardFields: Locator
  readonly textareaCard: Locator
  readonly textarea: Locator
  readonly otpCard: Locator
  readonly otpInput: Locator
  readonly activeOtpCell: Locator
  readonly checkboxCard: Locator
  readonly radioCard: Locator
  readonly radioGroup: Locator
  readonly switchCard: Locator
  readonly sliderCard: Locator
  readonly selectCard: Locator
  readonly comboboxCard: Locator
  readonly combobox: Locator
  readonly comboboxBox: Locator
  readonly comboboxInputRow: Locator
  readonly comboboxIcon: Locator
  readonly comboboxOptions: Locator
  readonly datePickerCard: Locator
  readonly datePicker: Locator
  readonly datePickerLabel: Locator
  readonly datePickerTrigger: Locator
  readonly datePickerIcon: Locator
  readonly datePickerDialog: Locator
  readonly datePickerGrid: Locator
  readonly previousMonth: Locator
  readonly nextMonth: Locator
  readonly toggleCard: Locator
  readonly toggleRow: Locator
  readonly toggleSeparator: Locator
  readonly toggleGroup: Locator
  readonly displaySection: Locator
  readonly displaySectionHeading: Locator
  readonly displaySectionLead: Locator
  readonly cardCard: Locator
  readonly badgeCard: Locator
  readonly liveDot: Locator
  readonly avatarCard: Locator
  readonly avatarGroup: Locator
  readonly tableCard: Locator
  readonly standingsTable: Locator
  readonly progressCard: Locator
  readonly skeletonCard: Locator
  readonly skeleton: Locator
  readonly aspectRatioCard: Locator
  readonly navSection: Locator
  readonly navSectionHeading: Locator
  readonly navSectionLead: Locator
  readonly tabsCard: Locator
  readonly tabList: Locator
  readonly tabPanel: Locator
  readonly accordionCard: Locator
  readonly breadcrumbCard: Locator
  readonly breadcrumb: Locator
  readonly paginationCard: Locator
  readonly pagination: Locator
  readonly navMenuCard: Locator
  readonly navMenuPanel: Locator
  readonly menubarCard: Locator
  readonly menubar: Locator
  readonly overlaysSection: Locator
  readonly overlaysSectionHeading: Locator
  readonly overlaysSectionLead: Locator

  readonly dialogCard: Locator
  readonly dialog: Locator
  readonly alertDialog: Locator
  readonly sheetCard: Locator
  readonly sheet: Locator
  readonly drawerCard: Locator
  readonly drawer: Locator
  readonly popoverCard: Locator
  readonly popover: Locator
  readonly tooltipCard: Locator
  readonly tooltipFrame: Locator
  readonly refreshButton: Locator
  readonly seedBadge: Locator
  readonly hoverCardCard: Locator
  readonly hoverCard: Locator
  readonly menuCard: Locator
  readonly dropdownMenu: Locator
  readonly contextMenu: Locator
  readonly commandCard: Locator
  readonly commandBox: Locator
  readonly commandInput: Locator
  readonly commandList: Locator
  readonly feedbackSection: Locator
  readonly feedbackSectionHeading: Locator
  readonly feedbackSectionLead: Locator
  readonly alertCard: Locator
  constructor(page: Page) {
    this.page = page
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
    // The paragraph right after the header.
    this.intro = page.getByRole('paragraph').first()
    this.formsSection = page.getByRole('region', { name: 'Forms & Input' })
    this.formsSectionHeading = this.formsSection.getByRole('heading', {
      level: 2,
    })
    this.formsSectionLead = this.formsSection.getByRole('paragraph')
    // Every section's component cards, whose titles are h3s. The demo cards
    // inside the Card card are articles too, with h4 titles.
    this.cards = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { level: 3 }) })
    this.buttonCard = this.formsSection.getByRole('article', { name: 'Button' })
    this.inputCard = this.formsSection.getByRole('article', {
      name: 'Input · Label · Form Field',
    })
    // The card's fields, each a label, its input and any help text.
    this.inputCardFields = this.inputCard.locator('.form-field')
    this.textareaCard = this.formsSection.getByRole('article', {
      name: 'Textarea',
    })
    this.textarea = this.textareaCard.getByRole('textbox', {
      name: 'Match notes',
    })
    this.otpCard = this.formsSection.getByRole('article', { name: 'Input OTP' })
    this.otpInput = this.otpCard.getByRole('textbox', {
      name: 'Verification code',
    })
    // The cells are hidden from assistive tech, so find the active one by its
    // class.
    this.activeOtpCell = this.otpCard.locator('.otp-cell--active')
    this.checkboxCard = this.formsSection.getByRole('article', {
      name: 'Checkbox',
    })
    this.radioCard = this.formsSection.getByRole('article', {
      name: 'Radio Group',
    })
    this.radioGroup = this.radioCard.getByRole('radiogroup', {
      name: 'Match format',
    })
    this.switchCard = this.formsSection.getByRole('article', { name: 'Switch' })
    this.sliderCard = this.formsSection.getByRole('article', { name: 'Slider' })
    this.selectCard = this.formsSection.getByRole('article', { name: 'Select' })
    this.comboboxCard = this.formsSection.getByRole('article', {
      name: 'Combobox',
    })
    this.combobox = this.comboboxCard.getByRole('combobox', {
      name: 'Find a player',
    })
    // The .cmd box around the input and its list, which draws the border.
    this.comboboxBox = this.comboboxCard.locator('.cmd')
    // The box's top row: the search icon and the input.
    this.comboboxInputRow = this.comboboxBox.locator('.cmd-input')
    this.comboboxIcon = this.comboboxInputRow.locator('svg')
    this.comboboxOptions = this.comboboxCard.getByRole('option')
    this.datePickerCard = this.formsSection.getByRole('article', {
      name: 'Date Picker',
    })
    // The picker's root, which the card lays out as the kit's row.
    this.datePicker = this.datePickerCard.locator('.date-picker')
    this.datePickerLabel = this.datePickerCard.getByText('Match date', {
      exact: true,
    })
    // Its name starts with the label, then the chosen date.
    this.datePickerTrigger = this.datePickerCard.getByRole('button', {
      name: /^Match date/,
    })
    this.datePickerIcon = this.datePickerTrigger.locator('svg')
    this.datePickerDialog = this.datePickerCard.getByRole('dialog', {
      name: 'Match date',
    })
    // Named by the month it shows.
    this.datePickerGrid = this.datePickerDialog.getByRole('grid')
    this.previousMonth = this.datePickerDialog.getByRole('button', {
      name: 'Previous month',
    })
    this.nextMonth = this.datePickerDialog.getByRole('button', {
      name: 'Next month',
    })
    this.toggleCard = this.formsSection.getByRole('article', {
      name: 'Toggle · Toggle Group',
    })
    // The kit's .row that lays out the toggles, the separator and the group.
    this.toggleRow = this.toggleCard.locator('.row')
    this.toggleSeparator = this.toggleCard.getByRole('separator')
    this.toggleGroup = this.toggleCard.getByRole('radiogroup', {
      name: 'Match type',
    })
    this.displaySection = page.getByRole('region', { name: 'Data Display' })
    this.displaySectionHeading = this.displaySection.getByRole('heading', {
      level: 2,
    })
    // The first paragraph: the cards in the section have paragraphs too.
    this.displaySectionLead = this.displaySection.getByRole('paragraph').first()
    this.cardCard = this.displaySection.getByRole('article', {
      name: 'Card',
      exact: true,
    })
    this.badgeCard = this.displaySection.getByRole('article', {
      name: 'Badge',
      exact: true,
    })
    // The dot is hidden from assistive tech, so it has no role to find it by.
    this.liveDot = this.badgeCard.locator('.ball-dot')
    this.avatarCard = this.displaySection.getByRole('article', {
      name: 'Avatar',
      exact: true,
    })
    this.avatarGroup = this.avatarCard.getByRole('group', { name: 'Players' })
    this.tableCard = this.displaySection.getByRole('article', {
      name: 'Table · Data Table',
      exact: true,
    })
    this.standingsTable = this.tableCard.getByRole('table', {
      name: 'Standings',
    })
    this.progressCard = this.displaySection.getByRole('article', {
      name: 'Progress',
      exact: true,
    })
    this.skeletonCard = this.displaySection.getByRole('article', {
      name: 'Skeleton',
      exact: true,
    })
    // The placeholders are hidden from assistive tech, so they have no role
    // to find them by.
    this.skeleton = this.skeletonCard.locator('.skeleton').first()
    this.aspectRatioCard = this.displaySection.getByRole('article', {
      name: 'Aspect Ratio',
      exact: true,
    })
    this.navSection = page.getByRole('region', { name: 'Navigation' })
    this.navSectionHeading = this.navSection.getByRole('heading', { level: 2 })
    // The first paragraph: the cards in the section have paragraphs too.
    this.navSectionLead = this.navSection.getByRole('paragraph').first()
    this.tabsCard = this.navSection.getByRole('article', {
      name: 'Tabs',
      exact: true,
    })
    this.tabList = this.tabsCard.getByRole('tablist', { name: 'Tournament' })
    // The chosen tab's panel: the others are hidden.
    this.tabPanel = this.tabsCard.getByRole('tabpanel')
    this.accordionCard = this.navSection.getByRole('article', {
      name: 'Accordion',
      exact: true,
    })
    this.breadcrumbCard = this.navSection.getByRole('article', {
      name: 'Breadcrumb',
      exact: true,
    })
    this.breadcrumb = this.breadcrumbCard.getByRole('navigation', {
      name: 'Breadcrumb',
    })
    this.paginationCard = this.navSection.getByRole('article', {
      name: 'Pagination',
      exact: true,
    })
    this.pagination = this.paginationCard.getByRole('navigation', {
      name: 'Pagination',
    })
    this.navMenuCard = this.navSection.getByRole('article', {
      name: 'Navigation Menu',
      exact: true,
    })
    this.navMenuPanel = this.navMenuCard.getByRole('list', { name: 'Product' })
    this.menubarCard = this.navSection.getByRole('article', {
      name: 'Menubar',
      exact: true,
    })
    this.menubar = this.menubarCard.getByRole('menubar', { name: 'App' })
    this.overlaysSection = page.getByRole('region', { name: 'Overlays' })
    this.overlaysSectionHeading = this.overlaysSection.getByRole('heading', {
      level: 2,
    })
    // The first paragraph: the cards in the section have paragraphs too.
    this.overlaysSectionLead = this.overlaysSection
      .getByRole('paragraph')
      .first()
    this.dialogCard = this.overlaysSection.getByRole('article', {
      name: 'Dialog · Alert Dialog',
      exact: true,
    })
    this.dialog = this.dialogCard.getByRole('dialog', {
      name: 'Forfeit this match?',
    })
    this.alertDialog = this.dialogCard.getByRole('alertdialog', {
      name: 'Delete account',
    })
    this.sheetCard = this.overlaysSection.getByRole('article', {
      name: 'Sheet',
      exact: true,
    })
    this.sheet = this.sheetCard.getByRole('dialog', { name: 'Filters' })
    this.drawerCard = this.overlaysSection.getByRole('article', {
      name: 'Drawer',
      exact: true,
    })
    this.drawer = this.drawerCard.getByRole('dialog', { name: 'Quick log' })
    this.popoverCard = this.overlaysSection.getByRole('article', {
      name: 'Popover',
      exact: true,
    })
    this.popover = this.popoverCard.getByRole('dialog', {
      name: 'Skill rating',
    })
    this.tooltipCard = this.overlaysSection.getByRole('article', {
      name: 'Tooltip',
      exact: true,
    })
    this.tooltipFrame = this.tooltipCard.locator('.mock-bg')
    this.refreshButton = this.tooltipCard.getByRole('button', {
      name: 'Refresh',
    })
    this.seedBadge = this.tooltipCard.getByText('Seed 1', { exact: true })
    this.hoverCardCard = this.overlaysSection.getByRole('article', {
      name: 'Hover Card',
      exact: true,
    })
    this.hoverCard = this.hoverCardCard.getByRole('group', {
      name: 'Tien Nguyen',
    })
    this.menuCard = this.overlaysSection.getByRole('article', {
      name: 'Dropdown Menu · Context Menu',
      exact: true,
    })
    this.dropdownMenu = this.menuCard.getByRole('menu', {
      name: 'Match actions',
    })
    this.contextMenu = this.menuCard.getByRole('menu', { name: 'Bracket' })
    this.commandCard = this.overlaysSection.getByRole('article', {
      name: 'Command',
      exact: true,
    })
    this.commandBox = this.commandCard.locator('.cmd')
    this.commandInput = this.commandCard.getByRole('combobox', {
      name: 'Command',
    })
    this.commandList = this.commandCard.getByRole('listbox', {
      name: 'Command',
    })
    this.feedbackSection = page.getByRole('region', { name: 'Feedback' })
    this.feedbackSectionHeading = this.feedbackSection.getByRole('heading', {
      level: 2,
    })
    // The first paragraph: the cards in the section have paragraphs too.
    this.feedbackSectionLead = this.feedbackSection
      .getByRole('paragraph')
      .first()
    this.alertCard = this.feedbackSection.getByRole('article', {
      name: 'Alert',
      exact: true,
    })
  }

  // A component card's title, in its header.
  cardTitle(card: Locator): Locator {
    return card.getByRole('heading', { level: 3 })
  }

  // A component card's mono tag, beside its title.
  cardTag(card: Locator): Locator {
    return card.locator('.tag')
  }

  // The one-time code's cell at `index`.
  otpCell(index: number): Locator {
    return this.otpCard.locator('.otp-cell').nth(index)
  }

  // Clicks the cell at `index` the way a user does: the input laid over the
  // cells takes the click.
  async clickOtpCell(index: number): Promise<void> {
    const input = (await this.otpInput.boundingBox())!
    const cell = (await this.otpCell(index).boundingBox())!
    await this.otpInput.click({
      position: {
        x: cell.x - input.x + cell.width / 2,
        y: cell.y - input.y + cell.height / 2,
      },
    })
  }

  // The Checkbox card's checkbox labelled `name`.
  checkbox(name: string): Locator {
    return this.checkboxCard.getByRole('checkbox', { name })
  }

  // The box that draws the checkbox labelled `name`.
  checkboxBox(name: string): Locator {
    return this.checkboxLabel(name).locator('.checkbox-box')
  }

  // The <label> holding the checkbox labelled `name` and its text.
  checkboxLabel(name: string): Locator {
    return this.checkboxCard.locator('label', { hasText: name })
  }

  // Clicks the checkbox labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden). It's a plain mouse click, so
  // it goes through on a disabled checkbox too, which Playwright's own
  // click() would wait on until it's enabled.
  async clickCheckboxLabel(name: string): Promise<void> {
    await this.clickText(this.checkboxCard, name)
  }

  // The Radio Group card's radio labelled `name`.
  radio(name: string): Locator {
    return this.radioGroup.getByRole('radio', { name })
  }

  // The dot that draws the radio labelled `name`.
  radioDot(name: string): Locator {
    return this.radioCard
      .locator('label', { hasText: name })
      .locator('.radio-dot')
  }

  // Clicks the radio labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden), with a plain mouse click, as
  // clickCheckboxLabel() does.
  async clickRadioLabel(name: string): Promise<void> {
    await this.clickText(this.radioCard, name)
  }

  // The Switch card's switch labelled `name`.
  switch(name: string): Locator {
    return this.switchCard.getByRole('switch', { name })
  }

  // The <label> row holding the switch labelled `name`, its text and track.
  switchLabel(name: string): Locator {
    return this.switchCard.locator('label', { hasText: name })
  }

  // The label text of the switch labelled `name`.
  switchText(name: string): Locator {
    return this.switchCard.getByText(name, { exact: true })
  }

  // The track that draws the switch labelled `name`.
  switchTrack(name: string): Locator {
    return this.switchLabel(name).locator('.switch-track')
  }

  // Clicks the switch labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden), with a plain mouse click, as
  // clickCheckboxLabel() does.
  async clickSwitchLabel(name: string): Promise<void> {
    await this.clickText(this.switchCard, name)
  }

  // The Slider card's slider (one input) named `name`.
  slider(name: string): Locator {
    return this.sliderCard.getByRole('slider', { name, exact: true })
  }

  // The .slider-field labelled `label`: its header, track and thumbs.
  sliderField(label: string): Locator {
    return this.sliderCard.locator('.slider-field', { hasText: label })
  }

  // The readout of the value of the slider labelled `label`.
  sliderValue(label: string): Locator {
    return this.sliderField(label).locator('output')
  }

  // The track of the slider labelled `label`.
  sliderTrack(label: string): Locator {
    return this.sliderField(label).locator('.slider-track')
  }

  // The thumb drawn for the slider named `name`, right after its input.
  sliderThumb(name: string): Locator {
    return this.slider(name).locator('xpath=following-sibling::*[1]')
  }

  // Drags the thumb drawn for the slider named `name` the way a user does:
  // presses its centre and moves the mouse to `fraction` of the track's
  // width, with plain mouse events, so it goes through on a disabled slider
  // too.
  async dragSlider(name: string, fraction: number): Promise<void> {
    const thumb = this.sliderThumb(name)
    await thumb.scrollIntoViewIfNeeded()
    const from = (await thumb.boundingBox())!
    // The .slider holding the input, as wide as its track.
    const track = (await this.slider(name).locator('xpath=..').boundingBox())!
    const y = from.y + from.height / 2
    await this.page.mouse.move(from.x + from.width / 2, y)
    await this.page.mouse.down()
    await this.page.mouse.move(track.x + track.width * fraction, y, {
      steps: 5,
    })
    await this.page.mouse.up()
  }

  // The Select card's select named `name`.
  select(name: string): Locator {
    return this.selectCard.getByRole('combobox', { name, exact: true })
  }

  // The calendar's day named `name`, e.g. "April 12, 2026".
  datePickerDay(name: string): Locator {
    return this.datePickerGrid.getByRole('gridcell', { name, exact: true })
  }

  // The standalone toggle named `name`, e.g. "Bold".
  toggle(name: string): Locator {
    return this.toggleCard.getByRole('button', { name, exact: true })
  }

  // The group's item named `name`, e.g. "Singles".
  toggleGroupItem(name: string): Locator {
    return this.toggleGroup.getByRole('radio', { name, exact: true })
  }

  // The Tabs card's tab named `name`, e.g. "Overview".
  tab(name: string): Locator {
    return this.tabList.getByRole('tab', { name, exact: true })
  }

  // The Accordion card's button that opens the question `name`.
  accordionTrigger(name: string): Locator {
    return this.accordionCard.getByRole('button', { name, exact: true })
  }

  // The Accordion card's answer to the question `name`, once it's open.
  accordionContent(name: string): Locator {
    return this.accordionCard.getByRole('region', { name, exact: true })
  }

  // The chevron beside the question `name`. It's hidden from assistive
  // tech, so it has no role to find it by.
  accordionChevron(name: string): Locator {
    return this.accordionTrigger(name).locator('.accordion-chevron')
  }

  // The breadcrumb's link named `name`, e.g. "Tournaments".
  breadcrumbLink(name: string): Locator {
    return this.breadcrumb.getByRole('link', { name, exact: true })
  }

  // The pagination's button named `name`, e.g. "Page 2" or "Next page".
  paginationButton(name: string): Locator {
    return this.pagination.getByRole('button', { name, exact: true })
  }

  // The navigation menu panel's link titled `title`, e.g. "Club tools".
  navMenuLink(title: string): Locator {
    return this.navMenuPanel.getByRole('link').filter({ hasText: title })
  }

  // The menubar's item named `name`, e.g. "File".
  menubarItem(name: string): Locator {
    return this.menubar.getByRole('menuitem', { name, exact: true })
  }

  // The tooltip card's tooltip reading `text`.
  tooltip(text: string): Locator {
    return this.tooltipCard.getByRole('tooltip').filter({ hasText: text })
  }

  // The dropdown menu's item named `name`, e.g. "Rematch".
  dropdownItem(name: string): Locator {
    return this.dropdownMenu.getByRole('menuitem', { name, exact: true })
  }

  // The command palette's option named `name`, e.g. "Log a match".
  commandOption(name: string): Locator {
    return this.commandList.getByRole('option', { name, exact: true })
  }

  // The alert card's alert titled `name`, e.g. "Heads up".
  alert(name: string): Locator {
    return this.alertCard.getByRole('alert', { name, exact: true })
  }

  // Clicks the middle of the text `name` in `card` with a plain mouse click.
  private async clickText(card: Locator, name: string): Promise<void> {
    const text = card.getByText(name, { exact: true })
    await text.scrollIntoViewIfNeeded()
    const box = (await text.boundingBox())!
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  // Opens the page. It shows no loading screen, so there's nothing to wait
  // out.
  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }

  // The input card's text input labelled `name`.
  input(name: string): Locator {
    return this.inputCard.getByRole('textbox', { name })
  }

  // The Card card's demo card titled `name`, e.g. "April Spring Open".
  demoCard(name: string): Locator {
    return this.cardCard.getByRole('article', { name, exact: true })
  }

  // The Badge card's badge reading `text`, e.g. "Seed 1".
  badge(text: string): Locator {
    return this.badgeCard.getByText(text, { exact: true })
  }

  // The Avatar card's avatars named `name`, e.g. "Tien Nguyen". Each name is
  // in both the row and the group.
  avatars(name: string): Locator {
    return this.avatarCard.getByRole('img', { name, exact: true })
  }

  // The Aspect Ratio card's box that reads `text`, e.g. "16 : 9".
  aspectRatioBox(text: string): Locator {
    return this.aspectRatioCard.getByText(text, { exact: true })
  }
}
