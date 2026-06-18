import userEvent from '@testing-library/user-event'
import { render, screen, type Container } from '@/test/utilities'
import { BroadcastView, type BroadcastViewProps } from './broadcast-view'
import { buildBroadcastViewProps } from './broadcast-view.factory'

const scoped = (container: Container) => ({
  getSearch() {
    return container.getByRole('textbox', { name: 'Search players' })
  },
  getSelectAll() {
    return container.getByRole('checkbox', { name: 'Send to all players' })
  },
  getRecipient(username: string) {
    return container.getByRole('checkbox', { name: username })
  },
  getTitleInput() {
    return container.getByLabelText('Title')
  },
  getBodyInput() {
    return container.getByLabelText('Message')
  },
  getSendButton() {
    return container.getByRole('button', { name: /send to/i })
  },
  querySuccess() {
    return container.queryByText(/queued for \d+ player/i)
  },
  queryError() {
    return container.queryByText('Broadcast failed')
  },
  queryHint(text: string) {
    return container.queryByText(text)
  },
  /** A preview section label (e.g. IN-APP / BELL). */
  queryPreviewSection(label: string) {
    return container.queryByText(label)
  },
})

export const broadcastViewPage = {
  render(overrides: Partial<BroadcastViewProps> = {}) {
    render(<BroadcastView {...buildBroadcastViewProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async clickSelectAll() {
    await userEvent.click(this.getSelectAll())
  },
  async clickRecipient(username: string) {
    await userEvent.click(this.getRecipient(username))
  },
  async clickSend() {
    await userEvent.click(this.getSendButton())
  },

  ...scoped(screen),
}
