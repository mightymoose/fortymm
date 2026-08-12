import userEvent from '@testing-library/user-event'

import {
  act,
  fireEvent,
  render,
  screen,
  within,
  type Container,
} from '@/test/utilities'
import { SetupPanel, type SetupPanelProps } from './setup-panel'
import { buildSetupPanelProps } from './setup-panel.factory'
import { COPIED_MARKER_MS } from './setup-panel/use-copy-to-clipboard'
import { claudeDialogDiagramPage } from './setup-panel/claude-dialog-diagram.page'
import { copyFieldPage } from './setup-panel/copy-field.page'

/**
 * How the Clipboard API behaves for a test. jsdom implements none of it, so
 * every case here is one a real browser produces:
 *
 * - `works` — a secure context with permission.
 * - `rejects` — `writeText` rejects (document not focused, permission denied).
 * - `absent` — `navigator.clipboard` is undefined (insecure context, older
 *   browser).
 */
export type ClipboardBehavior = 'works' | 'rejects' | 'absent'

/** The spy behind the current render's clipboard, so a test can read what was
 * actually written. */
let writeText: ReturnType<typeof installClipboard> | null = null

function installClipboard(behavior: ClipboardBehavior) {
  const spy = vi.fn<(value: string) => Promise<void>>(() =>
    behavior === 'rejects'
      ? Promise.reject(new Error('Document is not focused.'))
      : Promise.resolve(),
  )
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: behavior === 'absent' ? undefined : { writeText: spy },
  })
  return spy
}

const scoped = (container: Container) => {
  const panel = () =>
    container.getByRole('region', { name: 'Set up Claude access' })

  return {
    /** The panel, or null where it must not render (every state but `ready`). */
    querySetupPanel() {
      return container.queryByRole('region', { name: 'Set up Claude access' })
    },
    /** The panel, or a throw. */
    getSetupPanel: panel,
    /** Its numbered steps, in order. Scoped to the panel: the page around it
     * renders list items of its own. */
    getSteps() {
      return within(panel()).getAllByRole('listitem')
    },
    /** The polite live region that carries the copy result to a screen reader.
     * Present from first paint, empty until something is copied. */
    getAnnouncer() {
      return within(panel()).getByRole('status')
    },
    /** The email a player must sign in with, scoped to the panel. */
    queryPanelEmail(email: string) {
      return within(panel()).queryByText(email)
    },
    ...copyFieldPage.within(container),
    diagram: claudeDialogDiagramPage.within(container),
  }
}

/**
 * Test page-object for `SetupPanel`.
 *
 * `render` installs a Clipboard API (jsdom has none) — working by default, or
 * one of the two ways a real browser refuses. Read what reached it with
 * `getClipboardWrites()`. Parent page objects expose this surface under
 * `setup`, so nothing here has to avoid name collisions with the status row.
 */
export const setupPanelPage = {
  render(
    overrides: Partial<SetupPanelProps> = {},
    { clipboard = 'works' }: { clipboard?: ClipboardBehavior } = {},
  ) {
    writeText = installClipboard(clipboard)
    render(<SetupPanel {...buildSetupPanelProps(overrides)} />)
  },

  /** Every value written to the clipboard since this render, in order. */
  getClipboardWrites(): string[] {
    if (!writeText) {
      throw new Error('Render the panel before reading the clipboard.')
    }
    return writeText.mock.calls.map(([value]) => value)
  },

  /** Press a copy button by its visible label. */
  async clickCopy(buttonLabel: string) {
    await userEvent.click(screen.getByRole('button', { name: buttonLabel }))
  },

  /**
   * The same press, plus the microtask the clipboard write settles on, without
   * user-event — whose own `delay` never elapses under fake timers. Only the
   * marker-expiry test needs this; everything else uses `clickCopy`.
   */
  async clickCopyOnAFakeClock(buttonLabel: string) {
    fireEvent.click(screen.getByRole('button', { name: buttonLabel }))
    await act(async () => {})
  },

  /** Run the marker's countdown out. */
  async runMarkerClock() {
    await act(async () => {
      vi.advanceTimersByTime(COPIED_MARKER_MS)
    })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
