import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The More components section: a data table, tags, avatars and a progress
// bar, navigation, a menubar, a carousel of finished matches and an
// accordion. It has no lead line.
export class MoreSection extends SectionObject {
  readonly dataTable: Locator
  readonly tagsAvatarProgress: Locator
  readonly navigation: Locator
  readonly menubar: Locator
  readonly carousel: Locator
  readonly accordion: Locator
  // The line under the menubar that says which command was chosen.
  readonly chosen: Locator
  // The carousel's "1–3 of 5" between its buttons.
  readonly carouselPosition: Locator
  readonly carouselTrack: Locator

  constructor(page: Page) {
    super(page, 'more')
    this.dataTable = this.example('ex-data-table')
    this.tagsAvatarProgress = this.example('ex-tags-avatar-progress')
    this.navigation = this.example('ex-navigation')
    this.menubar = this.example('ex-menubar')
    this.carousel = this.example('ex-carousel')
    this.accordion = this.example('ex-accordion')
    this.chosen = this.menubar.getByText(/^Demo:|^Chose /)
    this.carouselPosition = this.carousel.locator('.fm-carousel__pos')
    this.carouselTrack = this.carousel.getByLabel('Finished matches, scroll sideways')
  }

  // The menubar's menu named `name` on the bar, e.g. "Schedule".
  menuButton(name: string): Locator {
    return this.menubar.getByRole('menubar').getByRole('menuitem', { name, exact: true })
  }

  // The open menu named `name`, e.g. "Schedule".
  menu(name: string): Locator {
    return this.menubar.getByRole('menu', { name, exact: true })
  }

  // The command named `name` in an open menu, e.g. "Add a break".
  command(name: string): Locator {
    return this.menubar.getByRole('menu').getByRole('menuitem', { name, exact: true })
  }

  // The section's button named `name`, e.g. "Next results".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }

  // The section's link named `name`, e.g. "Draws".
  link(name: string): Locator {
    return this.region.getByRole('link', { name, exact: true })
  }

  // The accordion's toggle named `name`, e.g. "Scheduling details".
  summary(name: string): Locator {
    return this.accordion.getByText(name, { exact: true })
  }
}
