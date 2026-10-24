import { useEffect, useId, useState } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Example, GallerySection } from './GallerySection'

// How long a demo button stays busy, as in the reference gallery.
export const BUSY_MS = 1400

// The reference's state matrix, which the app doesn't copy.
const stateMatrixUrl =
  'https://github.com/mightymoose/fortymm/blob/main/references/design-system/ui_kits/components/states.html'

// A button that shows `busyLabel` for BUSY_MS after a click, as if it were
// saving. Nothing is sent anywhere.
function BusyDemoButton({
  variant,
  label,
  busyLabel,
}: {
  variant: 'primary' | 'secondary'
  label: string
  busyLabel: string
}) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!busy) return
    const id = setTimeout(() => setBusy(false), BUSY_MS)
    return () => clearTimeout(id)
  }, [busy])

  return (
    <Button variant={variant} busy={busy} onClick={() => setBusy(true)}>
      {busy ? busyLabel : label}
    </Button>
  )
}

// The design system page's Buttons section: the reference gallery's
// `section-actions`.
export function ButtonsSection() {
  const reasonId = useId()
  return (
    <GallerySection
      id="actions"
      title="Buttons"
      lead="Label with the verb that happens. One primary per card or dialog."
    >
      <Example
        testId="ex-variants"
        title="Variants"
        description="Primary for the main action, secondary for alternatives, ghost for low-weight actions in a row, danger for removal (always confirmed)."
      >
        <div className="doc-row">
          <Button variant="primary">Call to table</Button>
          <Button variant="secondary">Reschedule</Button>
          <Button variant="ghost">Print score sheet</Button>
          <Button variant="danger">Withdraw player…</Button>
          <a className="fm-btn fm-btn--link" href="#match">
            View draw
          </a>
        </div>
        <div className="doc-row">
          <Button variant="secondary" size="sm">
            Small
          </Button>
          <Button variant="secondary">Default</Button>
          <Button variant="secondary" size="lg">
            Large
          </Button>
          <Button variant="secondary" icon aria-label="More options">
            <Icon name="more" />
          </Button>
        </div>
      </Example>
      <Example
        testId="ex-loading-and-disabled"
        title="Loading and disabled"
        description={
          'Loading keeps the button\'s colours and swaps the label ("Saving…"). Disabled looks the same under the pointer, and says why nearby.'
        }
      >
        <div className="doc-row">
          <BusyDemoButton
            variant="primary"
            label="Save result"
            busyLabel="Saving…"
          />
          <BusyDemoButton
            variant="secondary"
            label="Export results"
            busyLabel="Exporting…"
          />
          <Button variant="primary" busy>
            Saving…
          </Button>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          <Button variant="primary" aria-disabled="true" aria-describedby={reasonId}>
            Start match
          </Button>
          <p className="fm-help" id={reasonId}>
            Both players need to check in first. Park hasn't yet.
          </p>
        </div>
        <p className="fm-help">
          Every state side by side: <a href={stateMatrixUrl}>state matrix</a>.
        </p>
      </Example>
    </GallerySection>
  )
}
