import { render, screen, type Container } from '@/test/utilities'

import { SectionHeader, type SectionHeaderProps } from './section-header'
import { buildSectionHeaderProps } from './section-header.factory'

const scoped = (container: Container) => ({
  getTitle(title: string) {
    return container.getByText(title)
  },
})

/** Test page-object for `SectionHeader`. */
export const sectionHeaderPage = {
  render(overrides: Partial<SectionHeaderProps> = {}) {
    render(<SectionHeader {...buildSectionHeaderProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
