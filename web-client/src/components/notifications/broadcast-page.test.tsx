import { screen } from '@/test/utilities'
import { PERM } from '@/lib/permissions'
import { broadcastPageObject } from './broadcast-page.page'

describe('BroadcastPage gate', () => {
  it('renders the tool for a user with notifications.broadcast', async () => {
    broadcastPageObject.signInWithPermissions([PERM.NOTIFICATIONS_BROADCAST])
    broadcastPageObject.render()
    expect(await screen.findByText('Compose')).toBeInTheDocument()
    expect(broadcastPageObject.queryAccessDenied()).not.toBeInTheDocument()
  })

  it('refuses to render the tool without the permission', async () => {
    broadcastPageObject.signInWithPermissions([])
    broadcastPageObject.render()
    expect(await screen.findByText(/don't have access/)).toBeInTheDocument()
    expect(broadcastPageObject.queryComposeHeading()).not.toBeInTheDocument()
  })
})
