import userEvent from '@testing-library/user-event'

import { render, screen, within, type Container } from '@/test/utilities'
import {
  mockAllowAgentAccessEndpoint,
  type AgentAccessResolver,
} from '@/mocks/endpoints/settings/agent-access.endpoint'
import { server } from '@/mocks/server'
import { AllowAccessButton } from './allow-access-button'

/** The button's accessible name — stable across every state, so a press is
 * addressed the same way before, during and after the request. */
const ALLOW_LABEL = 'Allow Claude to connect'

const scoped = (container: Container) => {
  const button = () => container.getByRole('button', { name: ALLOW_LABEL })

  return {
    /** The re-allow button. Throws where it must exist. */
    getAllowButton: button,
    /**
     * The same, for asserting **absence** — every state but `revoked` must not
     * offer it.
     */
    queryAllowButton() {
      return container.queryByRole('button', { name: ALLOW_LABEL })
    },
    /**
     * The polite live region beneath the button, which carries "in flight" and
     * "that didn't work". Present from first paint and empty when idle.
     *
     * Found as the region inside the button's own wrapper rather than by a
     * page-wide `role="status"`: the setup panel has an announcer of its own,
     * and a page-wide lookup would stop saying *which* surface spoke.
     */
    getAllowNote() {
      const wrapper = button().parentElement
      if (!wrapper) throw new Error('The re-allow button has no wrapper.')
      return within(wrapper).getByRole('status')
    },
  }
}

/**
 * Test page-object for `AllowAccessButton`.
 *
 * It owns a mutation, so a test must stub `POST
 * /v1/settings/agent-access/allow` with `mockEndpoint` before pressing — and
 * `handlers.ts` has a default, so an unstubbed press succeeds rather than
 * erroring. No router harness: the button is the one action on this page that
 * isn't a link.
 */
export const allowAccessButtonPage = {
  /** Override `POST /v1/settings/agent-access/allow` for this test. */
  mockEndpoint(resolver: AgentAccessResolver) {
    mockAllowAgentAccessEndpoint(server, resolver)
  },

  render() {
    render(<AllowAccessButton />)
  },

  /** Press the re-allow button. */
  async clickAllow() {
    await userEvent.click(screen.getByRole('button', { name: ALLOW_LABEL }))
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
