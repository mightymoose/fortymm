import type { ComponentType } from 'react'
import type { GalleryFrame } from './GateGallery'
import { DashboardToast } from './GateParts'
import { accountPlayer, frames, guestPlayer, type QuestionFrame, type ToastAnswer } from './gateData'

const toasts: Record<ToastAnswer, { player: string; message: string }> = {
  'yes-new': { player: guestPlayer, message: `${guestPlayer} is your player now.` },
  'yes-existing': { player: accountPlayer, message: `3 matches added to ${accountPlayer}.` },
  manage: { player: accountPlayer, message: `You manage ${guestPlayer} now.` },
  remove: { player: accountPlayer, message: `${guestPlayer} removed from your account.` },
}

// The frames of gateData.ts for /login-gate1 and /login-gate3, drawn by the
// layout's `Screen`, then the dashboard toasts.
export function questionFrames(Screen: ComponentType<{ question: QuestionFrame }>): GalleryFrame[] {
  return frames.map((frame) => ({
    title: frame.title,
    render: () =>
      frame.kind === 'question' ? <Screen question={frame.question} /> : <DashboardToast {...toasts[frame.answer]} />,
  }))
}
