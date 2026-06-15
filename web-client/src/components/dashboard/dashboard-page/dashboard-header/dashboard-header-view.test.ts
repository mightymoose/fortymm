import { projectDashboardHeaderView } from './dashboard-header-view'

describe('projectDashboardHeaderView', () => {
  it('greets a signed-in user by their @username', () => {
    expect(projectDashboardHeaderView('rita.kovac').greeting).toBe(
      'Hi, @rita.kovac',
    )
  })

  it('falls back to a bare greeting before the username is known', () => {
    expect(projectDashboardHeaderView(undefined).greeting).toBe('Hi')
  })
})
