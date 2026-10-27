import { GateGallery } from './GateGallery'
import { GateScreen, MatchRows, MergeLine, PlayerLine, Step1Answers, Step2Answers, YesNote } from './GateParts'
import { guestPlayer, type QuestionFrame } from './gateData'

// Layout 2, activity first: the match rows lead, because people recognize
// their matches, not a random name. The name is secondary. On a desktop the
// answers sit beside the matches.
export function LoginGate2() {
  return (
    <GateGallery
      current="/login-gate2"
      description="The match rows lead, because people recognize their matches, not a random name. The player’s name is secondary."
      Screen={ActivityFirst}
    />
  )
}

function ActivityFirst({ question }: { question: QuestionFrame }) {
  const step1 = question.step === 1
  return (
    <GateScreen className="act">
      <div className="act-head">
        <h3 className="gate-title">{step1 ? 'Were these yours?' : 'Who played these?'}</h3>
        <p className="gate-intro">Someone played these matches on this device before you signed in.</p>
      </div>
      <div className="act-grid">
        <div className="act-card">
          <p className="act-card__count">3 matches today</p>
          <MatchRows size="lg" />
          <div className="act-card__as">
            <PlayerLine name={guestPlayer} sub="Played as this guest player" />
          </div>
        </div>
        <div className="act-side">
          {step1 ? (
            <>
              {question.account === 'existing' && <MergeLine />}
              <YesNote account={question.account} />
              <Step1Answers status={question.status} />
            </>
          ) : (
            <Step2Answers />
          )}
        </div>
      </div>
    </GateScreen>
  )
}
