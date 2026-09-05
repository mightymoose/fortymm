import { LinkCheckPage } from './link-check-page/link-check-page'
import { btnGhost, btnPrimary } from './styles'

export function AccountSwitchGate({ fromUsername, toUsername, onContinue, onCancel }: {
  fromUsername: string
  toUsername: string
  onContinue: () => void
  onCancel: () => void
}) {
  return <LinkCheckPage state="checking" eyebrow="Account switch"
    title={`Continue as ${toUsername}?`}
    subtitle={`You're signed in as ${fromUsername}. Continuing signs this browser out of that account and signs you in as ${toUsername}.`}
    footer={<div className="flex flex-col gap-3 break-words">
      <button type="button" style={btnPrimary} onClick={onContinue}>Continue as {toUsername}</button>
      <button type="button" style={btnGhost} onClick={onCancel}>Cancel</button>
    </div>}
  />
}


export function ReviewAccountSwitch({ onReview, onCancel }: { onReview: () => void, onCancel: () => void }) {
  return <LinkCheckPage state="error" eyebrow="Sign-in changed" title="Your sign-in changed"
    subtitle="Review this link again before continuing. The link has not been used."
    footer={<div className="flex flex-col gap-3">
      <button type="button" style={btnPrimary} onClick={onReview}>Review link</button>
      <button type="button" style={btnGhost} onClick={onCancel}>Cancel</button>
    </div>} />
}
