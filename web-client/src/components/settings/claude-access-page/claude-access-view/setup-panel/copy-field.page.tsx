import { render, screen, within, type Container } from '@/test/utilities'
import { CopyField, type CopyFieldProps } from './copy-field'
import { buildCopyFieldProps } from './copy-field.factory'

const scoped = (container: Container) => {
  /** A field's own subtree — the unit "the marker is on THIS field" is about. */
  const field = (label: string | RegExp) =>
    within(container.getByRole('group', { name: label }))

  return {
    /** The labelled field group, by its label. */
    getField(label: string | RegExp) {
      return container.getByRole('group', { name: label })
    },
    /** The same, absent when this panel state doesn't render it. */
    queryField(label: string | RegExp) {
      return container.queryByRole('group', { name: label })
    },
    /**
     * The value itself. Read by class: a bare run of text has no role and no
     * accessible name to reach it by, and a test-only wrapper or testid would
     * be markup that exists solely to serve tests.
     */
    getCopyValue(label: string | RegExp) {
      const value = container
        .getByRole('group', { name: label })
        .querySelector('.fmm-claude__copy-value')
      if (!value) throw new Error(`The "${String(label)}" field has no value.`)
      return value
    },
    /** A field's copy button, by its visible label. */
    getCopyButton(buttonLabel: string) {
      return container.getByRole('button', { name: buttonLabel })
    },
    /**
     * What that button's `aria-describedby` resolves to — the field label, so
     * "Copy URL" is announced as belonging to the connector URL rather than as
     * one of two similar buttons.
     */
    getCopyButtonDescription(buttonLabel: string) {
      const button = container.getByRole('button', { name: buttonLabel })
      const id = button.getAttribute('aria-describedby')
      const described = id ? document.getElementById(id) : null
      if (!described) throw new Error(`"${buttonLabel}" describes nothing.`)
      return described.textContent
    },
    /** The transient marker **inside that field**, or null. Scoped, because
     * "only one field is marked" is the whole assertion. */
    queryCopiedMarker(label: string | RegExp) {
      return field(label).queryByText('COPIED')
    },
    /** The same, awaited — the marker lands a microtask after the click. */
    findCopiedMarker(label: string | RegExp) {
      return field(label).findByText('COPIED')
    },
    /** The line shown when the clipboard couldn't be reached, or null. */
    queryCopyError(label: string | RegExp) {
      return field(label).queryByText(/couldn't reach your clipboard/i)
    },
    /** The same, awaited. */
    findCopyError(label: string | RegExp) {
      return field(label).findByText(/couldn't reach your clipboard/i)
    },
  }
}

/**
 * Test page-object for `CopyField`.
 *
 * Accessors take the field's **label** and resolve it to the field's group, so
 * the same surface works standalone and inside the setup panel, where two
 * fields are on screen at once.
 */
export const copyFieldPage = {
  render(overrides: Partial<CopyFieldProps> = {}) {
    const props = buildCopyFieldProps(overrides)
    render(<CopyField {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
