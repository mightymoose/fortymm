import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { Icon } from '../../components/Icon'
import { CodeForm, EmailForm, LoginOptions, Wordmark } from './loginSteps'
import { useLoginStep } from './useLoginStep'
import './login.css'

// Option 3: starts from the guest account every visitor already has. The
// page shows what the guest has so far, and the log in keeps it.
export function Login3() {
  const { step, sendCode, changeEmail } = useLoginStep()
  return (
    <main className="login">
      <LoginOptions />
      <div className="login-column">
        <Wordmark />
        <header className="login-head">
          <h1>Keep your matches</h1>
          <p>
            You're playing as a guest. Log in with your email and your matches
            stay with you on every device.
          </p>
        </header>
        <Card title="On this device" subtitle="Guest since 12 October">
          <DetailList
            details={[
              { term: 'Matches', value: '7', numeric: true },
              { term: 'Rating', value: '1,486', numeric: true },
              { term: 'Tournaments', value: '1', numeric: true },
            ]}
          />
        </Card>
        {step.kind === 'email' ? (
          <EmailForm onSubmit={sendCode} />
        ) : (
          <CodeForm email={step.email} onChangeEmail={changeEmail} />
        )}
        <p className="fm-notice">
          <Icon name="info" />
          <span>
            Already have an account? Log in with its email. We add these
            matches to it.
          </span>
        </p>
      </div>
    </main>
  )
}
