import { statusBadgePage } from './status-badge.page'

describe('StatusBadge', () => {
  it('labels a published tournament', () => {
    statusBadgePage.render({ status: 'published' })
    expect(statusBadgePage.getBadge()).toHaveTextContent('Published')
    expect(statusBadgePage.getBadge()).toHaveAttribute('data-status', 'published')
  })

  it('labels and marks a live tournament with the pulsing dot', () => {
    statusBadgePage.render({ status: 'live' })
    const badge = statusBadgePage.getBadge()
    expect(badge).toHaveTextContent('Live')
    expect(badge.querySelector('.ball-dot--live')).not.toBeNull()
  })

  it('labels a draft tournament', () => {
    statusBadgePage.render({ status: 'draft' })
    expect(statusBadgePage.getBadge()).toHaveTextContent('Draft')
  })

  it('labels an archived tournament', () => {
    statusBadgePage.render({ status: 'archived' })
    expect(statusBadgePage.getBadge()).toHaveTextContent('Archived')
  })
})
