import { Smartphone } from 'lucide-react'
import { channelSetupNudgePage } from './channel-setup-nudge.page'

describe('ChannelSetupNudge', () => {
  it('renders the title and supporting body', async () => {
    channelSetupNudgePage.render()
    await channelSetupNudgePage.findCta('Add email')
    expect(
      channelSetupNudgePage.queryText(
        'Add your email to get match results in your inbox.',
      ),
    ).toBeInTheDocument()
    expect(
      channelSetupNudgePage.queryText(
        "We'll send a sign-in link to confirm it. No marketing — ever.",
      ),
    ).toBeInTheDocument()
  })

  it('deep-links the CTA to the matching settings section', async () => {
    channelSetupNudgePage.render()
    const cta = await channelSetupNudgePage.findCta('Add email')
    expect(cta).toHaveAttribute('href', '/settings#sec-email')
  })

  it('renders the push variant with its own copy and target', async () => {
    channelSetupNudgePage.render({
      title: 'Turn on push to get pinged the second your match is called.',
      body: 'Install the FortyMM app and allow notifications to start receiving pushes.',
      cta: { label: 'Set up push', hash: 'sec-notifications', Icon: Smartphone },
    })
    const cta = await channelSetupNudgePage.findCta('Set up push')
    expect(cta).toHaveAttribute('href', '/settings#sec-notifications')
  })
})
