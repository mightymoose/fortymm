import type { ReactNode } from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { initials } from '../../components/initials'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { Toast } from '../../components/Toast'
import {
  accountPlayer,
  guestMatches,
  guestPlayer,
  type AccountCase,
  type SaveStatus,
} from './gateData'

// The parts that the three login gate layouts share. Every button is visual
// only: a click does nothing.

// The whole screen in place of the app: the wordmark at the top, then the
// question.
export function GateScreen({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`gate ${className}`}>
      <div className="gate-wordmark">FortyMM</div>
      <div className="gate-body">{children}</div>
    </div>
  )
}

export function Avatar({ name, size }: { name: string; size?: 'lg' | 'xl' }) {
  return (
    <span className={size ? `fm-avatar gate-avatar--${size}` : 'fm-avatar'} aria-hidden="true">
      {initials(name)}
    </span>
  )
}

// A player's avatar, name and one line under it.
export function PlayerLine({ name, sub, size }: { name: string; sub: string; size?: 'lg' }) {
  return (
    <div className="gate-player">
      <Avatar name={name} size={size} />
      <span className="gate-player__text">
        <span className="gate-player__name">{name}</span>
        <span className="gate-player__sub">{sub}</span>
      </span>
    </div>
  )
}

// Up to 3 of the guest player's matches, newest first.
export function MatchRows({ size }: { size?: 'lg' }) {
  return (
    <ul className={size ? `gate-matches gate-matches--${size}` : 'gate-matches'} aria-label="Recent matches">
      {guestMatches.map((match) => (
        <li key={match.time}>
          <span className="gate-matches__opponent">{match.opponent}</span>
          <span className={match.won ? 'gate-matches__result gate-matches__result--won' : 'gate-matches__result'}>
            {match.won ? 'Won' : 'Lost'} <span className="num">{match.score}</span>
          </span>
          <span className="gate-matches__time">{match.time}</span>
        </li>
      ))}
    </ul>
  )
}

// What joins what, for a sign-in to an existing account.
export function MergeLine() {
  return (
    <div className="gate-merge" role="group" aria-label="What Yes joins">
      <PlayerLine name={guestPlayer} sub="3 matches today" />
      <Icon name="right" className="gate-merge__arrow" />
      <PlayerLine name={accountPlayer} sub="Your player" />
    </div>
  )
}

// What "Yes" does, in one sentence.
export function YesNote({ account }: { account: AccountCase }) {
  return (
    <p className="gate-note">
      {account === 'new'
        ? `Yes makes ${guestPlayer} your player. It keeps its name.`
        : `Yes adds these 3 matches to ${accountPlayer}, your player. It keeps its name.`}
    </p>
  )
}

export function SaveError() {
  return (
    <div className="fm-alert fm-alert--error" role="alert">
      <Icon name="error" />
      <p className="fm-alert__title">Your answer wasn’t saved</p>
      <p className="fm-alert__body">We couldn’t reach FortyMM. Check your connection, then try again.</p>
      <div className="fm-alert__actions">
        <Button variant="secondary">Try again</Button>
      </div>
    </div>
  )
}

// Step 1's two answers. While "Yes" saves, it shows progress and the other
// answer is off.
export function Step1Answers({ status }: { status: SaveStatus }) {
  const saving = status === 'saving'
  return (
    <div className="gate-answers">
      {status === 'error' && <SaveError />}
      <Button variant="primary" size="xl" className="gate-answer" busy={saving}>
        {saving ? 'Saving…' : 'Yes, these were mine'}
      </Button>
      <Button variant="secondary" size="xl" className="gate-answer" aria-disabled={saving || undefined}>
        Someone else played these
      </Button>
    </div>
  )
}

// Step 2's two answers and Back.
export function Step2Answers() {
  return (
    <div className="gate-answers">
      <Button variant="secondary" className="gate-choice">
        <span className="gate-choice__label">I manage this player</span>
        <span className="gate-choice__help">
          For a kid or a club member you look after. It stays a separate player in your account.
        </span>
      </Button>
      <Button variant="secondary" className="gate-choice">
        <span className="gate-choice__label">Remove from my account</span>
        <span className="gate-choice__help">The player and its matches stay in FortyMM, but not in your account.</span>
      </Button>
      <Button variant="link" className="gate-back">
        <Icon name="left" />
        Back
      </Button>
    </div>
  )
}

// The dashboard right after an answer, simplified to its topbar, with the
// toast that confirms the answer. `player` is the account's player, in the
// topbar's chip.
export function DashboardToast({ player, message }: { player: string; message: string }) {
  return (
    <div className="gate-dash">
      <div className="gate-dash__bar">
        <span className="gate-dash__wordmark">FortyMM</span>
        <span className="gate-dash__chip">
          <PlayerAvatar name={player} />
          <span className="gate-dash__chip-name">{player}</span>
        </span>
      </div>
      <div className="gate-dash__body">
        <h3>Home</h3>
        <p className="meta">The dashboard, left out of this mockup.</p>
      </div>
      <div className="gate-dash__toast">
        <Toast role="status" message={message} onUndo={() => undefined} />
      </div>
    </div>
  )
}
