import userEvent from '@testing-library/user-event'

import { pageHeadingPage } from './page-heading.page'

describe('PageHeading', () => {
  it('renders the title', () => {
    pageHeadingPage.render({ title: 'Tournaments' })
    expect(pageHeadingPage.getTitle()).toHaveTextContent('Tournaments')
  })

  it('invokes a non-final breadcrumb crumb on click', async () => {
    const onClick = vi.fn()
    pageHeadingPage.render({
      breadcrumb: [{ label: 'Tournaments', onClick }, { label: 'Bay Area Open' }],
      title: 'Bay Area Open',
    })
    await userEvent.click(pageHeadingPage.getCrumbLink('Tournaments'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
