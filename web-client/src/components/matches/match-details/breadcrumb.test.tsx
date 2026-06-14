import { describe, expect, it } from 'vitest'

import { breadcrumbPage } from './breadcrumb.page'

describe('Breadcrumb', () => {
  it('shows the Matches parent link and the current-match label', async () => {
    breadcrumbPage.render({ matchId: 'abcdef0000' })

    await breadcrumbPage.findCurrent('Match abcdef')
    expect(breadcrumbPage.queryMatchesLink()).toHaveAttribute(
      'href',
      '/matches',
    )
  })
})
