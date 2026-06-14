import { render, screen, type Container } from '@/test/utilities'

import { PageHeading, type PageHeadingProps } from './page-heading'
import { buildPageHeadingProps } from './page-heading.factory'

const scoped = (container: Container) => ({
  getTitle() {
    return container.getByRole('heading', { level: 1 })
  },
  getCrumbLink(label: string) {
    return container.getByRole('button', { name: label })
  },
})

/** Test page-object for `PageHeading`. */
export const pageHeadingPage = {
  render(overrides: Partial<PageHeadingProps> = {}) {
    render(<PageHeading {...buildPageHeadingProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
