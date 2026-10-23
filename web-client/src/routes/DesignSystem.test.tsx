import { within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'

describe('DesignSystem', () => {
  it('shows the Design System title', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.title).toHaveTextContent('Design System')
  })

  it('introduces the design system under the header', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.intro).toHaveTextContent(
      /^Every FortyMM component, styled with the design system's tokens\./,
    )
  })

  it('has a Forms & Input section with a lead line', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.formsSectionHeading).toHaveTextContent(
      'Forms & Input',
    )
    expect(designSystemPage.formsSectionLead).toHaveTextContent(
      /^Buttons, inputs, selectors\./,
    )
  })

  it('has a Button card in the Forms & Input section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.buttonCardHeading).toHaveTextContent('Button')
    expect(designSystemPage.buttonCard).toHaveTextContent(
      '7 variants · 4 sizes',
    )
  })

  it.each([
    'Log a match',
    'Save draft',
    'Cancel',
    'Skip',
    'Forfeit match',
    'Read manifesto',
    'Small',
    'Default',
    'Large',
    'Add',
  ])('shows an enabled %s button', async (name) => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.button(name)).toBeEnabled()
  })

  it('shows a disabled button', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.button('Disabled')).toBeDisabled()
  })

  it('has an Input · Label · Form Field card in the Forms & Input section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.inputCardHeading).toHaveTextContent(
      'Input · Label · Form Field',
    )
    expect(designSystemPage.inputCard).toHaveTextContent('composite')
  })

  it('describes the Player tag input with its help text', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Player tag')
    expect(input).toHaveValue('@nguyen.t')
    expect(input).toHaveAttribute('placeholder', '@yourname')
    expect(input).toHaveAccessibleDescription(
      'Visible to opponents in match invites.',
    )
    expect(input).toBeValid()
    expect(input).not.toBeRequired()
  })

  it('shows a required, invalid Email input with an error', async () => {
    const designSystemPage = await DesignSystemPage.render()

    // The label's asterisk isn't part of the input's name.
    const input = designSystemPage.input('Email')
    expect(input).toHaveValue('not-an-email')
    expect(input).toBeRequired()
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('Enter a valid email address.')
  })

  it('shows a disabled input', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Disabled')
    expect(input).toBeDisabled()
    expect(input).toHaveValue('Locked field')
  })

  it('shows a Search input with no description', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Search')
    expect(input).toHaveAttribute(
      'placeholder',
      'Search clubs, players, tournaments…',
    )
    expect(input).toHaveValue('')
    expect(input).not.toHaveAccessibleDescription()
  })

  it('shows the Textarea card after the Input card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.textareaCardHeading).toHaveTextContent('Textarea')
    expect(designSystemPage.textareaCard).toHaveTextContent('resizable')
    expect(
      designSystemPage.inputCard.compareDocumentPosition(
        designSystemPage.textareaCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a labelled Match notes textarea', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const textarea = designSystemPage.textarea
    expect(textarea).toHaveValue(
      "Played in the back hall. Andrew's forehand was on fire today — three straight games to 11.",
    )
    expect(textarea).toHaveAttribute(
      'placeholder',
      'Add context — venue, conditions, anything memorable.',
    )
    expect(textarea).not.toHaveAccessibleDescription()
  })
  it('shows the Input OTP card after the Textarea card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.otpCardHeading).toHaveTextContent('Input OTP')
    expect(designSystemPage.otpCard).toHaveTextContent('6-digit')
    expect(
      designSystemPage.textareaCard.compareDocumentPosition(
        designSystemPage.otpCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a one-time code input with a hidden label', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.otpInput
    expect(input).toHaveValue('40MM')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')
    expect(input).not.toHaveAccessibleDescription()
    expect(designSystemPage.otpLabel).toHaveClass('visually-hidden')
  })

  it('shows the Checkbox card after the Input OTP card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.checkboxCardHeading).toHaveTextContent('Checkbox')
    expect(designSystemPage.checkboxCard).toHaveTextContent('3 states')
    expect(
      designSystemPage.otpCard.compareDocumentPosition(
        designSystemPage.checkboxCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a checked, an unchecked and a disabled checkbox', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const agree = designSystemPage.checkbox('I agree to the rules of fair play')
    expect(agree).toBeChecked()
    expect(agree).toBeEnabled()
    const invites = designSystemPage.checkbox('Email me match invites')
    expect(invites).not.toBeChecked()
    expect(invites).toBeEnabled()
    const disabled = designSystemPage.checkbox('Disabled option')
    expect(disabled).not.toBeChecked()
    expect(disabled).toBeDisabled()
  })

  it('shows the Radio Group card after the Checkbox card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.radioCardHeading).toHaveTextContent('Radio Group')
    expect(designSystemPage.radioCard).toHaveTextContent('single-select')
    expect(
      designSystemPage.checkboxCard.compareDocumentPosition(
        designSystemPage.radioCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a match format group with the first option selected', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.radioGroupLabel).toHaveClass('visually-hidden')
    const options = [
      'Singles · best of 5',
      'Singles · best of 7',
      'Doubles · best of 5',
    ].map((name) => designSystemPage.radio(name))
    expect(options[0]).toBeChecked()
    expect(options[1]).not.toBeChecked()
    expect(options[2]).not.toBeChecked()
    const name = options[0].getAttribute('name')
    expect(name).toBeTruthy()
    for (const option of options) {
      expect(option).toBeEnabled()
      expect(option).toHaveAttribute('name', name)
    }
  })

  it('shows the Switch card after the Radio Group card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.switchCardHeading).toHaveTextContent('Switch')
    expect(designSystemPage.switchCard).toHaveTextContent('on/off')
    expect(
      designSystemPage.radioCard.compareDocumentPosition(
        designSystemPage.switchCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows an on and an off switch', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const profile = designSystemPage.switch('Public profile')
    expect(profile).toBeChecked()
    expect(profile).toBeEnabled()
    const nearby = designSystemPage.switch('Notify me of nearby matches')
    expect(nearby).not.toBeChecked()
    expect(nearby).toBeEnabled()
  })

  it('shows the Slider card after the Switch card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.sliderCardHeading).toHaveTextContent('Slider')
    expect(designSystemPage.sliderCard).toHaveTextContent('single + range')
    expect(
      designSystemPage.switchCard.compareDocumentPosition(
        designSystemPage.sliderCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a single slider and a range slider with their values', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.slider('Skill level')).toHaveValue('1620')
    expect(designSystemPage.slider('Rating range minimum')).toHaveValue('1400')
    expect(designSystemPage.slider('Rating range maximum')).toHaveValue('1800')
    expect(
      designSystemPage.sliderValues.map((readout) => readout.textContent),
    ).toEqual(['1620', '1400 – 1800'])
  })

  it('shows the Select card after the Slider card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.selectCardHeading).toHaveTextContent('Select')
    expect(designSystemPage.selectCard).toHaveTextContent('native')
    expect(
      designSystemPage.sliderCard.compareDocumentPosition(
        designSystemPage.selectCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows two selects with the reference's options", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const type = designSystemPage.select('Match type')
    expect(type).toHaveValue('Singles')
    expect(
      within(type)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Singles', 'Doubles'])
    expect(type).toBeEnabled()
    const length = designSystemPage.select('Match length')
    expect(length).toHaveValue('Best of 5 games')
    expect(length).toBeEnabled()
  })

  it('shows the Combobox card after the Select card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.comboboxCardHeading).toHaveTextContent('Combobox')
    expect(designSystemPage.comboboxCard).toHaveTextContent(
      'searchable select · open',
    )
    expect(
      designSystemPage.selectCard.compareDocumentPosition(
        designSystemPage.comboboxCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's query and its three matches, the first active", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const combobox = designSystemPage.combobox
    expect(combobox).toHaveValue('ngu')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    const options = designSystemPage.comboboxOptions
    expect(options.map((option) => option.textContent)).toEqual([
      'Nguyen, Tien 1620',
      'Nguyen, Mai 1455',
      'Nguyen, Phuc 1380',
    ])
    expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(
      options.map((option) => option.getAttribute('aria-selected')),
    ).toEqual(['true', 'false', 'false'])
  })

  it('shows the Date Picker card after the Combobox card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.datePickerCardHeading).toHaveTextContent(
      'Date Picker',
    )
    expect(designSystemPage.datePickerCard).toHaveTextContent(
      'calendar in popover',
    )
    expect(
      designSystemPage.comboboxCard.compareDocumentPosition(
        designSystemPage.datePickerCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows the Toggle card after the Date Picker card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.toggleCardHeading).toHaveTextContent(
      'Toggle · Toggle Group',
    )
    expect(designSystemPage.toggleCard).toHaveTextContent('single + multi')
    expect(
      designSystemPage.datePickerCard.compareDocumentPosition(
        designSystemPage.toggleCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's toggles: Bold pressed, Italic not, then a separator and the group with Singles chosen", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.toggle('Bold')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(designSystemPage.toggle('Bold')).toHaveTextContent('B')
    expect(designSystemPage.toggle('Italic')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(designSystemPage.toggle('Italic')).toHaveTextContent('I')
    expect(designSystemPage.toggleSeparator).toHaveAttribute(
      'aria-orientation',
      'vertical',
    )
    const items = designSystemPage.toggleGroupItems
    expect(items.map((item) => item.textContent)).toEqual([
      'Singles',
      'Doubles',
      'Mixed',
    ])
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ])
  })

  it('has a Data Display section after Forms & Input, with a lead line', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.displaySectionHeading).toHaveTextContent(
      'Data Display',
    )
    expect(designSystemPage.displaySectionLead).toHaveTextContent(
      'Cards, tables, badges, avatars. The product is ratings and rankings — these components are where the numbers live.',
    )
    expect(
      designSystemPage.formsSection.compareDocumentPosition(
        designSystemPage.displaySection,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('has a Card card in the Data Display section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.cardCardHeading).toHaveTextContent('Card')
    expect(designSystemPage.cardCard).toHaveTextContent('container')
  })

  it('has a Badge card after the Card card in the Data Display section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.badgeCardHeading).toHaveTextContent('Badge')
    expect(designSystemPage.badgeCard).toHaveTextContent('5 variants')
    expect(
      designSystemPage.cardCard.compareDocumentPosition(
        designSystemPage.badgeCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's five badges in order", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      designSystemPage.badges.map((badge) => badge.textContent),
    ).toEqual([
      'Seed 1',
      'Doubles',
      'Pending',
      'Disqualified',
      'Live · Court 3',
    ])
  })

  it('has an Avatar card after the Badge card in the Data Display section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.avatarCardHeading).toHaveTextContent('Avatar')
    expect(designSystemPage.avatarCard).toHaveTextContent(
      'image · initials · stack',
    )
    expect(
      designSystemPage.badgeCard.compareDocumentPosition(
        designSystemPage.avatarCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's avatars in order, then the group's overflow", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      designSystemPage.avatars.map((avatar) => avatar.getAttribute('aria-label')),
    ).toEqual([
      'Tien Nguyen',
      'Daniel Okafor',
      'Marta Kowalski',
      'Tien Nguyen',
      'Daniel Okafor',
      'Marta Kowalski',
      '12 more',
    ])
  })

  it('stacks the last three avatars and the overflow in a group', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      within(designSystemPage.avatarGroup)
        .getAllByRole('img')
        .map((avatar) => avatar.getAttribute('aria-label')),
    ).toEqual(['Tien Nguyen', 'Daniel Okafor', 'Marta Kowalski', '12 more'])
  })

  it('has a Table · Data Table card after the Avatar card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.tableCardHeading).toHaveTextContent(
      'Table · Data Table',
    )
    expect(designSystemPage.tableCard).toHaveTextContent('sortable rows')
    expect(
      designSystemPage.avatarCard.compareDocumentPosition(
        designSystemPage.tableCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("heads the standings table with the reference's columns", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      within(designSystemPage.standingsTable)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Player', 'Club', 'Rating', 'W-L', 'Δ'])
  })

  it("shows the reference's standings, a signed rating change last", async () => {
    const designSystemPage = await DesignSystemPage.render()
    const [, ...rows] = within(designSystemPage.standingsTable).getAllByRole(
      'row',
    )

    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(1)
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['Brooklyn TT', '1620', '14\u20133', '+18'],
      ['NYC Open Hall', '1582', '11\u20134', '+12'],
      ['Brooklyn TT', '1505', '8\u20136', '\u22124'],
    ])
  })

  it.each([
    [0, 'Tien Nguyen', 'Nguyen, Tien'],
    [1, 'Daniel Okafor', 'Okafor, Daniel'],
    [2, 'Marta Kowalski', 'Kowalski, Marta'],
  ])(
    "shows row %i's player as an avatar of %s beside %j",
    async (index, name, shown) => {
      const designSystemPage = await DesignSystemPage.render()
      const [, ...rows] = within(designSystemPage.standingsTable).getAllByRole(
        'row',
      )
      const player = within(rows[index]).getAllByRole('cell')[0]

      expect(within(player).getByRole('img')).toHaveAccessibleName(name)
      expect(within(player).getByText(shown)).toBeVisible()
    },
  )

  it('has a Progress card after the Table · Data Table card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.progressCardHeading).toHaveTextContent('Progress')
    expect(designSystemPage.progressCard).toHaveTextContent('determinate')
    expect(
      designSystemPage.tableCard.compareDocumentPosition(
        designSystemPage.progressCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's two bars, a round's matches and a group's", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      designSystemPage.progressBars.map((bar) => [
        bar.getAttribute('aria-valuenow'),
        bar.getAttribute('aria-valuemax'),
        bar.getAttribute('aria-valuetext'),
      ]),
    ).toEqual([
      ['12', '16', '12 of 16'],
      ['25', '100', '25%'],
    ])
    expect(designSystemPage.progressBars[0]).toHaveAccessibleName(
      'Round 1 of 5',
    )
    expect(designSystemPage.progressBars[1]).toHaveAccessibleName('Group B')
    expect(designSystemPage.progressCard).toHaveTextContent('12 / 16')
    expect(designSystemPage.progressCard).toHaveTextContent('25%')
  })

  it('has a Skeleton card after the Progress card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.skeletonCardHeading).toHaveTextContent('Skeleton')
    expect(designSystemPage.skeletonCard).toHaveTextContent('loading state')
    expect(
      designSystemPage.progressCard.compareDocumentPosition(
        designSystemPage.skeletonCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("hides the Skeleton card's three placeholders from assistive tech", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.skeletons).toHaveLength(3)
    for (const skeleton of designSystemPage.skeletons) {
      expect(skeleton).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('has an Aspect Ratio card after the Skeleton card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.aspectRatioCardHeading).toHaveTextContent(
      'Aspect Ratio',
    )
    expect(designSystemPage.aspectRatioCard).toHaveTextContent(
      '16:9 · 4:3 · 1:1',
    )
    expect(
      designSystemPage.skeletonCard.compareDocumentPosition(
        designSystemPage.aspectRatioCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's two boxes, 16 : 9 and 1 : 1", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(
      designSystemPage.aspectRatioBoxes.map((box) => box.textContent),
    ).toEqual(['16 : 9', '1 : 1'])
  })

  it('has a Navigation section after Data Display, with a lead line', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.navSectionHeading).toHaveTextContent('Navigation')
    expect(designSystemPage.navSectionLead).toHaveTextContent(
      'Tabs, breadcrumbs, pagination, menus. Wayfinding inside the app.',
    )
    expect(
      designSystemPage.displaySection.compareDocumentPosition(
        designSystemPage.navSection,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('has a Tabs card first in the Navigation section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.tabsCardHeading).toHaveTextContent('Tabs')
    expect(designSystemPage.tabsCard).toHaveTextContent('underlined or boxed')
    expect(
      designSystemPage.navSectionLead.compareDocumentPosition(
        designSystemPage.tabsCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's four tabs, Overview chosen with its panel", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.tabs.map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Schedule',
      'Standings',
      'Players',
    ])
    expect(
      designSystemPage.tabs.map((tab) => tab.getAttribute('aria-selected')),
    ).toEqual(['true', 'false', 'false', 'false'])
    expect(designSystemPage.tabPanel).toHaveTextContent(
      'Tournament overview — 32 players, 4 courts, finals projected for 6:45pm.',
    )
  })

  it('has an Accordion card after the Tabs card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.accordionCardHeading).toHaveTextContent(
      'Accordion',
    )
    expect(designSystemPage.accordionCard).toHaveTextContent('collapsible FAQ')
    expect(
      designSystemPage.tabsCard.compareDocumentPosition(
        designSystemPage.accordionCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's three questions, only the first open", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const triggers = designSystemPage.accordionTriggers
    expect(
      triggers.map((trigger) => [
        trigger.textContent,
        trigger.getAttribute('aria-expanded'),
      ]),
    ).toEqual([
      ['How does the SMT scheduler work?⌄', 'true'],
      ['Is FortyMM really free?⌄', 'false'],
      ['How do ratings update?⌄', 'false'],
    ])
    for (const trigger of triggers) {
      expect(trigger.parentElement?.tagName).toBe('H4')
    }
    expect(
      designSystemPage.accordionContents.map((content) => content.textContent),
    ).toEqual([
      'It treats every match as a constraint and solves for an assignment that minimizes back-to-backs, balances court usage, and respects player breaks.',
    ])
  })

  it('has a Breadcrumb card after the Accordion card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.breadcrumbCardHeading).toHaveTextContent(
      'Breadcrumb',
    )
    expect(designSystemPage.breadcrumbCard).toHaveTextContent('trail')
    expect(
      designSystemPage.accordionCard.compareDocumentPosition(
        designSystemPage.breadcrumbCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's trail, Round 3 the current page", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const breadcrumb = designSystemPage.breadcrumb
    expect(
      within(breadcrumb)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Tournaments', 'April Spring Open'])
    expect(within(breadcrumb).getByText('Round 3')).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('has a Pagination card after the Breadcrumb card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.paginationCardHeading).toHaveTextContent(
      'Pagination',
    )
    expect(designSystemPage.paginationCard).toHaveTextContent('paged tables')
    expect(
      designSystemPage.breadcrumbCard.compareDocumentPosition(
        designSystemPage.paginationCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's row, page 1 of 12", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const pagination = designSystemPage.pagination
    expect(pagination).toHaveTextContent('‹123…12›')
    expect(
      within(pagination).getByRole('button', { name: 'Page 1' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('has a Navigation Menu card after the Pagination card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.navMenuCardHeading).toHaveTextContent(
      'Navigation Menu',
    )
    expect(designSystemPage.navMenuCard).toHaveTextContent('mega-dropdown')
    expect(
      designSystemPage.paginationCard.compareDocumentPosition(
        designSystemPage.navMenuCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's Product panel, labelled as hovered", async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.navMenuCard).toHaveTextContent('Hovered: Product')
    expect(
      within(designSystemPage.navMenuPanel)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Match recorderTrack scores in real time, no internet needed.',
      'Tournament adminSMT-solved draws and live scoring.',
      'Spectator bracketsShareable, public, branded.',
      'Club toolsMember rosters, ladder leagues.',
    ])
  })

  it('has a Menubar card after the Navigation Menu card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.menubarCardHeading).toHaveTextContent('Menubar')
    expect(designSystemPage.menubarCard).toHaveTextContent('desktop app')
    expect(
      designSystemPage.navMenuCard.compareDocumentPosition(
        designSystemPage.menubarCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's five menus, File active", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const items = designSystemPage.menubarItems
    expect(items.map((item) => item.textContent)).toEqual([
      'File',
      'Edit',
      'View',
      'Tournament',
      'Help',
    ])
    expect(
      items.filter((item) => item.classList.contains('menubar-item--active')),
    ).toEqual([items[0]])
  })

  it('has an Overlays section after Navigation, with a lead line', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.overlaysSectionHeading).toHaveTextContent(
      'Overlays',
    )
    expect(designSystemPage.overlaysSectionLead).toHaveTextContent(
      'Dialogs, sheets, popovers, menus. Content that floats above the canvas. All shown in their open state.',
    )
    expect(
      designSystemPage.navSection.compareDocumentPosition(
        designSystemPage.overlaysSection,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('has a Dialog · Alert Dialog card first in the Overlays section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.dialogCardHeading).toHaveTextContent(
      'Dialog · Alert Dialog',
    )
    expect(designSystemPage.dialogCard).toHaveTextContent('modal')
    expect(
      within(designSystemPage.overlaysSection).getAllByRole('article')[0],
    ).toBe(designSystemPage.dialogCard)
  })

  it("shows the reference's dialog and alert dialog, open", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const { dialog, alertDialog } = designSystemPage
    expect(dialog).toHaveAccessibleName('Forfeit this match?')
    expect(dialog).toHaveAccessibleDescription(
      "Your opponent will be awarded the win and your rating will be adjusted accordingly. This can't be undone.",
    )
    expect(
      within(dialog).getByRole('checkbox', {
        name: 'Send a note to my opponent',
      }),
    ).not.toBeChecked()
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Forfeit'])
    expect(alertDialog).toHaveAccessibleName('Delete account')
    expect(alertDialog).toHaveAccessibleDescription(
      'All match history, ratings, and tournament records will be permanently deleted.',
    )
    expect(
      within(alertDialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Keep account', 'Delete'])
    expect(
      Array.from(
        designSystemPage.dialogCard.querySelectorAll('.mock-label'),
        (label) => label.textContent,
      ),
    ).toEqual(['Dialog', 'Alert Dialog'])
  })

  it('has a Sheet card after the Dialog · Alert Dialog card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.sheetCardHeading).toHaveTextContent('Sheet')
    expect(designSystemPage.sheetCard).toHaveTextContent('side panel')
    expect(
      designSystemPage.dialogCard.compareDocumentPosition(
        designSystemPage.sheetCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("shows the reference's Filters sheet, open", async () => {
    const designSystemPage = await DesignSystemPage.render()

    const sheet = designSystemPage.sheet
    expect(designSystemPage.sheetCard).toHaveTextContent('Sheet (right)')
    expect(sheet).toHaveAccessibleName('Filters')
    expect(sheet).toHaveAccessibleDescription('Narrow the player list.')
    expect(within(sheet).getByRole('combobox', { name: 'Club' })).toHaveValue(
      'Brooklyn TT',
    )
    expect(
      within(sheet).getByRole('slider', { name: 'Rating range minimum' }),
    ).toHaveValue('1300')
    expect(
      within(sheet).getByRole('slider', { name: 'Rating range maximum' }),
    ).toHaveValue('2200')
    expect(
      within(sheet).getByRole('button', { name: 'Apply filters' }),
    ).toBeInTheDocument()
  })

  it.each([
    {
      title: 'April Spring Open',
      description: 'Hosted by Brooklyn TT Club',
      body: '32 players, single-elimination, 4 courts. Scheduling auto-generated by SMT solver.',
      buttons: ['Register', 'View draw'],
    },
    {
      title: '★ Featured',
      description: 'National Championships qualifier',
      body: 'Top 8 advance to the regional bracket. Limited to USATT members.',
      buttons: ['Apply'],
    },
  ])(
    "shows the reference's $title card",
    async ({ title, description, body, buttons }) => {
      const designSystemPage = await DesignSystemPage.render()

      const card = designSystemPage.demoCard(title)
      expect(
        within(card).getByRole('heading', { level: 4, name: title }),
      ).toBeInTheDocument()
      expect(card).toHaveTextContent(
        `${title}${description}${body}${buttons.join('')}`,
      )
      expect(
        within(card)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(buttons)
    },
  )

  describe('on April 14, 2026', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("shows the reference's April 2026, open, the 12th chosen and the 14th today", async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 3, 14, 12))
      const designSystemPage = await DesignSystemPage.render()

      const trigger = designSystemPage.datePickerTrigger
      expect(trigger).toHaveAccessibleName('Match date April 12, 2026')
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(designSystemPage.datePickerDialog).toHaveAccessibleName(
        'Match date',
      )
      expect(designSystemPage.datePickerGrid).toHaveAccessibleName(
        'April 2026',
      )
      expect(
        designSystemPage.datePickerDay('April 12, 2026'),
      ).toHaveAttribute('aria-selected', 'true')
      expect(
        designSystemPage.datePickerDay('April 14, 2026'),
      ).toHaveAttribute('aria-current', 'date')
      expect(document.body).toHaveFocus()
    })
  })
})
