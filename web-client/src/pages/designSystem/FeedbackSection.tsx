import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { RestIndicator } from '../../components/RestIndicator'
import { Toast } from '../../components/Toast'
import { useToast } from '../../components/toastContext'
import { BusyDemoButton } from './BusyDemoButton'
import { DemoButton } from './DemoButton'
import { Example, GallerySection } from './GallerySection'

// Does nothing: the static toast copy is visual only.
function ignore() {}

// The Toast example's buttons. Calling the match relabels its button until
// Undo calls it back, as the gallery's `data-done-label` does.
function ToastDemo() {
  const showToast = useToast()
  const [called, setCalled] = useState(false)
  const callButton = useRef<HTMLButtonElement>(null)

  return (
    <div className="doc-row">
      <Button
        ref={callButton}
        variant="secondary"
        aria-disabled={called || undefined}
        onClick={() => {
          setCalled(true)
          showToast('Chen vs Ali called to Table 1', {
            undo: () => {
              flushSync(() => setCalled(false))
              callButton.current?.focus()
            },
          })
        }}
      >
        {called ? 'Called · Table 1' : 'Call Chen vs Ali'}
      </Button>
      <Button variant="secondary" onClick={() => showToast('Table 4 marked free')}>
        Mark Table 4 free
      </Button>
    </div>
  )
}

// The Warning and error example. Moving the doubles resolves the warning
// into a notice, and Undo brings the warning back.
function WarningAndErrorDemo() {
  const showToast = useToast()
  const [moved, setMoved] = useState(false)
  const moveButton = useRef<HTMLButtonElement>(null)

  return (
    <>
      <div className="fm-alert fm-alert--warning" hidden={moved}>
        <Icon name="alert" />
        <p className="fm-alert__title">Okafor-Adeyemi is booked on two tables at 12:00</p>
        <p className="fm-alert__body">His doubles on Table 4 overlaps his singles on Table 1.</p>
        <div className="fm-alert__actions">
          <Button
            ref={moveButton}
            variant="primary"
            size="sm"
            onClick={() => {
              setMoved(true)
              showToast('Doubles moved to 12:40', {
                // The button is hidden with the warning until the re-render
                // shows it again, so it can only take focus after that.
                undo: () => {
                  flushSync(() => setMoved(false))
                  moveButton.current?.focus()
                },
              })
            }}
          >
            Move doubles to 12:40
          </Button>
          <DemoButton variant="secondary" size="sm">
            Choose another time
          </DemoButton>
        </div>
      </div>
      <p className="fm-notice fm-notice--success" hidden={!moved}>
        <Icon name="check" />
        <span>Doubles moved to 12:40. Okafor-Adeyemi has 5 minutes between his matches.</span>
      </p>
      <div className="fm-alert fm-alert--error" role="alert">
        <Icon name="offline" />
        <p className="fm-alert__title">Table 4 scorer is offline</p>
        <p className="fm-alert__body">
          Last score arrived at 11:42. Points entered on that device will sync when it
          reconnects.
        </p>
        <div className="fm-alert__actions">
          <DemoButton variant="primary" size="sm">
            Score from this device
          </DemoButton>
          <BusyDemoButton
            variant="secondary"
            size="sm"
            label="Send a reminder"
            busyLabel="Sending…"
          />
        </div>
      </div>
    </>
  )
}

// The design system page's Feedback section: the reference gallery's
// `section-feedback`.
export function FeedbackSection() {
  return (
    <GallerySection
      id="feedback"
      title="Feedback"
      lead="Match the weight of the message to what you need to do about it."
    >
      <Example
        testId="ex-toast"
        title="Toast"
        description="Confirms something you just did. Compact, raised, bottom centre. Undo when the action can be reversed. Leaves after 6 s; pauses while hovered or focused. Never for errors."
      >
        <ToastDemo />
        <Toast
          role="status"
          message="Chen vs Ali called to Table 1"
          action={{ label: 'Undo', onClick: ignore }}
          onDismiss={ignore}
        />
        <p className="doc-vo">Static copy above is visual only</p>
      </Example>
      <Example
        testId="ex-inline-notice"
        title="Inline notice"
        description="A sentence with an icon, inside the content it's about. No box. Use for rest times, timing info and quiet confirmations."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
          <p className="fm-notice fm-notice--rest">
            <Icon name="clock" />
            <span>
              <b>Lindqvist rests until 12:10.</b> Table 3 can start after that.
            </span>
          </p>
          <p className="fm-notice">
            <Icon name="info" />
            <span>
              Scores update live for spectators; ratings update when a result is saved.
            </span>
          </p>
          <p className="fm-notice fm-notice--success">
            <Icon name="check" />
            <span>Schedule updated. Expected finish 18:45.</span>
          </p>
        </div>
      </Example>
      <Example
        testId="ex-warning-and-error"
        title="Warning and error"
        description={
          <>
            The title says what's wrong, the body why, the buttons fix it. They stay
            until resolved. Errors use <code>role="alert"</code>; warnings don't
            interrupt.
          </>
        }
        stageStyle={{ maxWidth: 620 }}
      >
        <WarningAndErrorDemo />
      </Example>
      <Example
        testId="ex-status-set"
        title="Status set"
        description="Reviewed together so no two read alike. Each has its own hue, a non-colour cue and a place it belongs."
      >
        <div className="doc-status">
          <div>
            <span className="live-marker">Live</span>
            <h4>Live</h4>
            <p>Red dot + word. Static. One per match, never on the border.</p>
          </div>
          <div>
            <span className="fm-status fm-status--danger">
              <Icon name="error" />
              Didn't sync
            </span>
            <h4>Error</h4>
            <p>Something failed. Red icon + sentence + recovery action. Persists.</p>
          </div>
          <div>
            <Button variant="danger" size="sm">
              Withdraw…
            </Button>
            <h4>Destructive</h4>
            <p>Red outline on the action only. Always confirmed in a dialog.</p>
          </div>
          <div>
            <RestIndicator until="12:10" />
            <h4>Rest</h4>
            <p>Blue clock + the end time. Information, not a problem.</p>
          </div>
          <div>
            <span className="fm-status fm-status--conflict">
              <Icon name="alert" />
              Needs decision
            </span>
            <h4>Conflict</h4>
            <p>Amber triangle. Organizer screens, always with a suggested fix.</p>
          </div>
          <div>
            <span className="fm-status fm-status--offline">Scorer offline</span>
            <h4>Disconnected</h4>
            <p>Hollow grey dot. Scores shown greyed with the last update time.</p>
          </div>
        </div>
      </Example>
    </GallerySection>
  )
}
