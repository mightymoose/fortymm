import { useState } from 'react'
import { Alert } from '../../components/Alert'
import { ComponentCard } from '../../components/ComponentCard'
import { Section } from '../../components/Section'
import { Toast, type ToastAction, type ToastVariant } from '../../components/Toast'

// The Sonner / Toast card's toasts. Only the first has an action.
const toasts: {
  id: string
  variant: ToastVariant
  title: string
  description: string
  action?: ToastAction
}[] = [
  {
    id: 'update',
    variant: 'info',
    title: 'A new version of FortyMM is ready',
    description: 'Reload to get the latest update.',
    action: { label: 'Reload', onClick: () => {} },
  },
  {
    id: 'logged',
    variant: 'success',
    title: 'Match logged',
    description: 'Rating: 1620 (+18)',
  },
  {
    id: 'save-failed',
    variant: 'error',
    title: "Couldn't save",
    description: 'Try again — your changes are still in the editor.',
  },
  {
    id: 'reminder',
    variant: 'info',
    title: 'Reminder',
    description: "You're up next on Court 3.",
  },
]

export function FeedbackSection() {
  const [shownToasts, setShownToasts] = useState(toasts)

  function dismissToast(id: string) {
    setShownToasts((current) => current.filter((toast) => toast.id !== id))
  }

  return (
    <Section
      id="feedback"
      title="Feedback"
      lead="Alerts and toasts. The app talking back."
    >
      <ComponentCard title="Alert" tag="4 variants">
        <div className="col">
          <Alert title="Heads up" headingLevel={4}>
            The next round starts in 12 minutes.
          </Alert>
          <Alert variant="warn" title="Late check-in" headingLevel={4}>
            3 players haven't checked in. They'll be defaulted at 6:00pm.
          </Alert>
          <Alert
            variant="destructive"
            title="Match disputed"
            headingLevel={4}
          >
            A player has filed a score dispute. Review the appeal in the
            admin panel.
          </Alert>
          <Alert variant="success" title="Match logged" headingLevel={4}>
            Your rating moved from 1602 to 1620 (+18).
          </Alert>
        </div>
      </ComponentCard>
      {/* The kit's tag names four variants but shows three, info twice.
          Dismissing a toast removes it. Its action dismisses it too, and
          Reload doesn't reload the page. */}
      <ComponentCard title="Sonner / Toast" tag="4 variants">
        <div className="col toast-demo">
          {shownToasts.map((toast) => (
            <Toast
              key={toast.id}
              variant={toast.variant}
              title={toast.title}
              description={toast.description}
              action={toast.action}
              onDismiss={() => dismissToast(toast.id)}
            />
          ))}
        </div>
      </ComponentCard>
    </Section>
  )
}
