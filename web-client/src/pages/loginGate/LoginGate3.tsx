import { Icon } from '../../components/Icon'
import { GateGallery } from './GateGallery'
import { Avatar, GateScreen, MatchRows, PlayerLine, Step1Answers, Step2Answers } from './GateParts'
import {
  accountActivity,
  accountPlayer,
  guestActivity,
  guestPlayer,
  mergedActivity,
  type QuestionFrame,
} from './gateData'

// Layout 3, side by side: the guest player beside the account's player, and
// the result of a merge under them. A first sign-in has one card. On a phone
// the cards stack.
export function LoginGate3() {
  return (
    <GateGallery
      current="/login-gate3"
      description="The guest player and the account’s player side by side, with the result of the merge. A first sign-in shows one card."
      Screen={SideBySide}
    />
  )
}

function GuestCard() {
  return (
    <div className="pair-card">
      <div className="pair-card__who">
        <Avatar name={guestPlayer} size="lg" />
        <span className="gate-player__text">
          <span className="pair-card__role">Guest player on this device</span>
          <span className="pair-card__name">{guestPlayer}</span>
        </span>
      </div>
      <p>{guestActivity}</p>
      <MatchRows />
    </div>
  )
}

function SideBySide({ question }: { question: QuestionFrame }) {
  if (question.step === 2) {
    return (
      <GateScreen className="pair">
        <div className="pair-head">
          <h3 className="gate-title">Who played these?</h3>
        </div>
        <div className="pair-step2">
          <GuestCard />
          <Step2Answers />
        </div>
      </GateScreen>
    )
  }
  const existing = question.account === 'existing'
  return (
    <GateScreen className="pair">
      <div className="pair-head">
        <h3 className="gate-title">Were these yours?</h3>
        <p className="gate-intro">Someone played these matches on this device before you signed in.</p>
      </div>
      <div className={existing ? 'pair-cards' : 'pair-cards pair-cards--one'}>
        <GuestCard />
        {existing && (
          <>
            <Icon name="right" className="pair-arrow" />
            <div className="pair-card">
              <div className="pair-card__who">
                <Avatar name={accountPlayer} size="lg" />
                <span className="gate-player__text">
                  <span className="pair-card__role">Your player</span>
                  <span className="pair-card__name">{accountPlayer}</span>
                </span>
              </div>
              <p>{accountActivity}.</p>
            </div>
          </>
        )}
      </div>
      <div className="pair-result">
        <p className="label">If you answer Yes</p>
        {existing ? (
          <PlayerLine name={accountPlayer} size="lg" sub={`${mergedActivity}. It keeps its name.`} />
        ) : (
          <PlayerLine name={guestPlayer} size="lg" sub="Your player, with its 3 matches and its name." />
        )}
      </div>
      <Step1Answers status={question.status} />
    </GateScreen>
  )
}
