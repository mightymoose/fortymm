import { GateGallery } from './GateGallery'
import { Avatar, GateScreen, MatchRows, MergeLine, Step1Answers, Step2Answers, YesNote } from './GateParts'
import { guestActivity, guestPlayer, type QuestionFrame } from './gateData'

// Layout 1, the profile picker: a large centred avatar and name, the
// activity under it, and the answers as large buttons.
export function LoginGate1() {
  return (
    <GateGallery
      current="/login-gate1"
      description="Like a streaming service’s “Who’s watching?”. A large avatar and name, the activity under it, and the answers as large buttons."
      Screen={ProfilePicker}
    />
  )
}

function ProfilePicker({ question }: { question: QuestionFrame }) {
  if (question.step === 2) {
    return (
      <GateScreen className="pick">
        <div className="pick-profile">
          <Avatar name={guestPlayer} size="lg" />
          <p className="pick-name">{guestPlayer}</p>
          <p className="pick-activity">{guestActivity}</p>
        </div>
        <h3 className="gate-title">Who played these?</h3>
        <Step2Answers />
      </GateScreen>
    )
  }
  return (
    <GateScreen className="pick">
      <h3 className="gate-title">Were these yours?</h3>
      <div className="pick-profile">
        <Avatar name={guestPlayer} size="xl" />
        <p className="pick-name">{guestPlayer}</p>
        <p className="pick-activity">{guestActivity}</p>
      </div>
      <MatchRows />
      {question.account === 'existing' && <MergeLine />}
      <YesNote account={question.account} />
      <Step1Answers status={question.status} />
    </GateScreen>
  )
}
